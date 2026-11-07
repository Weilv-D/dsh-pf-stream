/**
 * ASR 路由：缓存缺口 → 切分 → 切片编码 → provider（verbose 优先，
 * 400 拒绝时降级 basic）→ PTS 锚定 → 幻觉清洗 → 缓存回写。
 *
 * 失败语义：单块失败计入 failedChunks（partial），不中断其余块；
 * verbose 被兼容端拒绝时整窗自动降级 basic（VAD 岛切分 + 整块文本锚定）。
 */

import {
  planChunks,
  planHostChunks,
  planIslandChunks,
  sliceAudio,
  type VadScanOptions,
} from './acousticVad.js';
import {
  transcribeBasic,
  transcribeHostSpeech,
  transcribeVerbose,
  AsrRequestError,
  type RawSegment,
} from './asrProviders.js';
import { guardSegments } from './hallucinationGuard.js';
import {
  cachedSegmentsFor,
  engineFingerprint,
  mergeInterval,
  missingRanges,
  renumberSegmentsGlobally,
  videoFingerprint,
  type TranscriptInterval,
} from './transcriptCache.js';
import type { AsrSettings, TranscriptSegment, VadResult } from './types.js';

export interface AsrRunOptions {
  ffmpegPath: string;
  settings: AsrSettings;
  cacheDir: string;
  cacheEnabled: boolean;
  sliceCodec: 'mp3' | 'opus';
  tempDir?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface AsrRunResult {
  /** 窗口内全部可用段（缓存命中 + 本次新转写，时间序）。 */
  segments: TranscriptSegment[];
  failedChunks: number;
  /** 失败原因采样（≤5 条，异常 message 原文；空数组 = 无失败）。 */
  failureSamples: string[];
  requests: number;
  droppedByGuard: number;
  cacheHit: boolean;
  /** verbose → basic 自动降级发生。 */
  degradedToBasic: boolean;
}

interface ChunkOutcome {
  range: [number, number];
  raw: RawSegment[];
  anchorStartMs: number;
}

async function runChunks(
  videoPath: string,
  chunks: Array<[number, number]>,
  provider: AsrSettings['provider'],
  options: AsrRunOptions,
): Promise<{ outcomes: ChunkOutcome[]; failed: number; requests: number; verboseRejected: boolean; failureSamples: string[] }> {
  const outcomes: ChunkOutcome[] = [];
  let failed = 0;
  let requests = 0;
  let verboseRejected = false;
  // 失败原因采样（≤5 条）：块失败此前零诊断（failedChunks 只有计数），
  // 网络错/HTTP 错/切片错无从归因。保异常 message 原文，供遥测透出。
  const failureSamples: string[] = [];
  const maxInFlight = Math.max(1, options.settings.maxConcurrency);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const vadOpts: VadScanOptions = { ffmpegPath: options.ffmpegPath, signal: options.signal };
  const runOne = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= chunks.length) return;
      const range = chunks[index];
      if (range === undefined) return;
      try {
        requests++;
        // 官方 SenseVoice provider 只接受 WAV；其余 provider 使用用户配置的压缩编码。
        const sliceCodec = provider === 'host_sensevoice' ? 'wav' : options.sliceCodec;
        const audio = await sliceAudio(videoPath, range, sliceCodec, vadOpts);
        const input = {
          startMs: range[0],
          endMs: range[1],
          bytes: audio.bytes,
          mimeType: audio.mimeType,
        };
        let raw: RawSegment[];
        if (provider === 'openai_verbose') {
          try {
            raw = await transcribeVerbose(input, { settings: options.settings, signal: options.signal });
          } catch (error) {
            if (error instanceof AsrRequestError && error.code === 'ASR_VERBOSE_REJECTED') {
              verboseRejected = true;
              raw = await transcribeBasic(input, { settings: options.settings, signal: options.signal });
            } else {
              throw error;
            }
          }
        } else if (provider === 'openai_basic') {
          raw = await transcribeBasic(input, { settings: options.settings, signal: options.signal });
        } else if (provider === 'host_sensevoice') {
          raw = await transcribeHostSpeech(input, { settings: options.settings, signal: options.signal });
        } else {
          const { transcribeLocalCli } = await import('./asrProviders.js');
          raw = await transcribeLocalCli(input, { settings: options.settings, signal: options.signal }, options.tempDir);
        }
        outcomes.push({ range, raw, anchorStartMs: range[0] });
      } catch (error) {
        failed++;
        if (failureSamples.length < 5) {
          failureSamples.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  };
  for (let i = 0; i < Math.min(maxInFlight, chunks.length); i++) workers.push(runOne());
  await Promise.all(workers);
  return { outcomes, failed, requests, verboseRejected, failureSamples };
}

/** 相对毫秒 → 绝对 PTS 毫秒（clamp 到块区间）。 */
function anchor(outcome: ChunkOutcome): TranscriptSegment[] {
  const span = outcome.range[1] - outcome.range[0];
  return outcome.raw
    .map((r) => ({
      segId: 0,
      startMs: outcome.anchorStartMs + Math.max(0, Math.min(span, r.startMs)),
      endMs: outcome.anchorStartMs + Math.max(0, Math.min(span, r.endMs)),
      text: r.text,
      source: 'asr' as const,
      noSpeechProb: r.noSpeechProb,
      avgLogprob: r.avgLogprob,
      compressionRatio: r.compressionRatio,
    }))
    .filter((s) => s.endMs > s.startMs && s.text.length > 0);
}

export async function transcribeWindow(
  videoPath: string,
  window: [number, number],
  vad: VadResult | null,
  options: AsrRunOptions,
): Promise<AsrRunResult> {
  const fingerprint = `${await videoFingerprint(videoPath)}-${engineFingerprint(options.settings)}`;
  let intervals: TranscriptInterval[] = [];
  let cacheHit = false;
  if (options.cacheEnabled) {
    const { readTranscriptCache, writeTranscriptCache } = await import('./transcriptCache.js');
    intervals = (await readTranscriptCache(options.cacheDir, fingerprint)) ?? [];
    cacheHit = intervals.length > 0;
    const gaps = missingRanges(intervals, window);
    if (gaps.length === 0 || gaps.every(([a, b]) => b - a <= 500)) {
      const cached = cachedSegmentsFor(intervals, window);
      return {
        segments: cached,
        failedChunks: 0,
        failureSamples: [],
        requests: 0,
        droppedByGuard: 0,
        cacheHit,
        degradedToBasic: false,
      };
    }

    const chunks = planChunksFor(gaps, vad, options.settings.provider);
    const result = await runChunks(videoPath, chunks, options.settings.provider, options);
    let segments: TranscriptSegment[] = [];
    let droppedByGuard = 0;
    for (const outcome of result.outcomes.sort((a, b) => a.anchorStartMs - b.anchorStartMs)) {
      const anchored = anchor(outcome);
      const guarded = guardSegments(anchored, vad);
      droppedByGuard += guarded.dropped;
      segments = segments.concat(guarded.segments);
    }
    // 缓存记录锚定并清洗后的段（保证幂等）；segId 区间内先占位，
    // 全部区间合并完成后统一全局重编号再落盘与拼接
    for (const outcome of result.outcomes.sort((a, b) => a.anchorStartMs - b.anchorStartMs)) {
      const guarded = guardSegments(anchor(outcome), vad);
      if (guarded.segments.length > 0 || outcome.range[1] > outcome.range[0]) {
        intervals = mergeInterval(intervals, {
          startMs: outcome.range[0],
          endMs: outcome.range[1],
          source: 'asr',
          segments: guarded.segments.map((s, i) => ({ ...s, segId: i + 1 })),
        });
      }
    }
    renumberSegmentsGlobally(intervals);
    await writeTranscriptCache(options.cacheDir, fingerprint, intervals).catch(() => undefined);

    const merged = cachedSegmentsFor(intervals, window);
    return {
      segments: merged.length > 0 ? merged : segments,
      failedChunks: result.failed,
      failureSamples: result.failureSamples,
      requests: result.requests,
      droppedByGuard,
      cacheHit,
      degradedToBasic: result.verboseRejected,
    };
  }

  // 无缓存路径：整窗直转。anchor 的 segId 为占位 0，
  // 输出前按时间序全局重编号（mountSegments 以 segId 作段身份键）。
  const chunks = planChunksFor([window], vad, options.settings.provider);
  const result = await runChunks(videoPath, chunks, options.settings.provider, options);
  let segments: TranscriptSegment[] = [];
  let droppedByGuard = 0;
  for (const outcome of result.outcomes.sort((a, b) => a.anchorStartMs - b.anchorStartMs)) {
    const guarded = guardSegments(anchor(outcome), vad);
    droppedByGuard += guarded.dropped;
    segments = segments.concat(guarded.segments);
  }
  segments.sort((a, b) => a.startMs - b.startMs);
  segments.forEach((s, i) => {
    s.segId = i + 1;
  });
  return {
    segments,
    failedChunks: result.failed,
    failureSamples: result.failureSamples,
    requests: result.requests,
    droppedByGuard,
    cacheHit: false,
    degradedToBasic: result.verboseRejected,
  };
}

function planChunksFor(
  ranges: Array<[number, number]>,
  vad: VadResult | null,
  provider: AsrSettings['provider'],
): Array<[number, number]> {
  // 无时间戳 provider（openai_basic / host_sensevoice）按语音岛直切：
  // basic 整块文本只能按块区间锚定，岛切掉静音段可同时减少静音区幻觉输入；
  // host provider 用更短的 15s 块，降低块级时间戳的挂载粒度。
  const out: Array<[number, number]> = [];
  for (const range of ranges) {
    out.push(
      ...(provider === 'openai_basic'
        ? planIslandChunks(range, vad)
        : provider === 'host_sensevoice'
          ? planHostChunks(range, vad)
          : planChunks(range, vad)),
    );
  }
  return out;
}
