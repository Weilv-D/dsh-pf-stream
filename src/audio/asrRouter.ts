/**
 * ASR 路由：缓存缺口 → 切分 → 切片编码 → provider（verbose 优先，
 * 400 拒绝时降级 basic）→ PTS 锚定 → 幻觉清洗 → 缓存回写。
 *
 * 失败语义：单块失败计入 failedChunks（partial），不中断其余块；
 * verbose 被兼容端拒绝时整窗自动降级 basic（VAD 岛切分 + 整块文本锚定）。
 */

import {
  planChunks,
  planIslandChunks,
  sliceAudio,
  type VadScanOptions,
} from './acousticVad.js';
import { transcribeBasic, transcribeVerbose, AsrRequestError, type RawSegment } from './asrProviders.js';
import { guardSegments } from './hallucinationGuard.js';
import {
  cachedSegmentsFor,
  mergeInterval,
  missingRanges,
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
  provider: 'openai_verbose' | 'openai_basic' | 'local_cli',
  options: AsrRunOptions,
): Promise<{ outcomes: ChunkOutcome[]; failed: number; requests: number; verboseRejected: boolean }> {
  const outcomes: ChunkOutcome[] = [];
  let failed = 0;
  let requests = 0;
  let verboseRejected = false;
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
        const audio = await sliceAudio(videoPath, range, options.sliceCodec, vadOpts);
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
        } else {
          const { transcribeLocalCli } = await import('./asrProviders.js');
          raw = await transcribeLocalCli(input, { settings: options.settings, signal: options.signal }, options.tempDir);
        }
        outcomes.push({ range, raw, anchorStartMs: range[0] });
      } catch {
        failed++;
      }
    }
  };
  for (let i = 0; i < Math.min(maxInFlight, chunks.length); i++) workers.push(runOne());
  await Promise.all(workers);
  return { outcomes, failed, requests, verboseRejected };
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
  const fingerprint = await videoFingerprint(videoPath);
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
        requests: 0,
        droppedByGuard: 0,
        cacheHit,
        degradedToBasic: false,
      };
    }

    const chunks = planChunksFor(gaps, vad);
    const result = await runChunks(videoPath, chunks, options.settings.provider, options);
    let segments: TranscriptSegment[] = [];
    let droppedByGuard = 0;
    for (const outcome of result.outcomes.sort((a, b) => a.anchorStartMs - b.anchorStartMs)) {
      const anchored = anchor(outcome);
      const guarded = guardSegments(anchored, vad);
      droppedByGuard += guarded.dropped;
      segments = segments.concat(guarded.segments);
    }
    // 缓存记录锚定后的段（清洗前锚定，清洗后回写）——以清洗后为准，保证幂等
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
    await writeTranscriptCache(options.cacheDir, fingerprint, intervals).catch(() => undefined);

    const merged = cachedSegmentsFor(intervals, window);
    return {
      segments: merged.length > 0 ? merged : segments,
      failedChunks: result.failed,
      requests: result.requests,
      droppedByGuard,
      cacheHit,
      degradedToBasic: result.verboseRejected,
    };
  }

  // 无缓存路径：整窗直转
  const chunks = planChunksFor([window], vad);
  const result = await runChunks(videoPath, chunks, options.settings.provider, options);
  let segments: TranscriptSegment[] = [];
  let droppedByGuard = 0;
  for (const outcome of result.outcomes.sort((a, b) => a.anchorStartMs - b.anchorStartMs)) {
    const guarded = guardSegments(anchor(outcome), vad);
    droppedByGuard += guarded.dropped;
    segments = segments.concat(guarded.segments);
  }
  return {
    segments,
    failedChunks: result.failed,
    requests: result.requests,
    droppedByGuard,
    cacheHit: false,
    degradedToBasic: result.verboseRejected,
  };
}

function planChunksFor(ranges: Array<[number, number]>, vad: VadResult | null): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const range of ranges) {
    out.push(...planChunks(range, vad));
  }
  return out;
}

/** basic/无时间戳 provider 的岛切分包装。 */
export async function transcribeWindowByIslands(
  videoPath: string,
  window: [number, number],
  vad: VadResult | null,
  options: AsrRunOptions,
): Promise<AsrRunResult> {
  const islands = planIslandChunks(window, vad);
  const result = await runChunks(videoPath, islands, options.settings.provider, options);
  let segments: TranscriptSegment[] = [];
  let droppedByGuard = 0;
  for (const outcome of result.outcomes.sort((a, b) => a.anchorStartMs - b.anchorStartMs)) {
    const guarded = guardSegments(anchor(outcome), vad);
    droppedByGuard += guarded.dropped;
    segments = segments.concat(guarded.segments);
  }
  return {
    segments,
    failedChunks: result.failed,
    requests: result.requests,
    droppedByGuard,
    cacheHit: false,
    degradedToBasic: false,
  };
}
