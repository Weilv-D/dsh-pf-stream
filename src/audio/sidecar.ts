/**
 * Audio Sidecar 门面：三级获取顺位（字幕 → VAD+ASR → 跳过）、
 * 软截止并行编排、画布包挂载与提示行生成。
 *
 * 铁律：任何音频路径异常都折叠为 status='error'/'timeout_skipped'，
 * 不向视觉主链路抛错；无音轨时视觉输出与无本模块时逐字节一致。
 */

import { isSilentWindow, scanVad } from './acousticVad.js';
import { loadSubtitleTimeline, sliceSegments } from './subtitleExtractor.js';
import { speechRateCps } from './hallucinationGuard.js';
import { transcribeWindow } from './asrRouter.js';
import type {
  AudioContextSummary,
  AudioPluginConfig,
  AudioSourceKind,
  AudioSettings,
  AudioStatus,
  IntentAudioDirective,
  PacketAudioMount,
  TranscriptSegment,
  VadResult,
} from './types.js';
import type { ProbeResult, IntentDirective } from '../types.js';

const MOUNT_MARGIN_MS = 300;
/** 跨包 (cont.) 副本的最小重叠（毫秒）。 */
const CONT_MIN_OVERLAP_MS = 150;
const ASSIST_STATIC_MS = 10_000;
const ASSIST_SINCE_F_MS = 3_000;
const ASSIST_PAUSE_AFTER_ISLAND_MS = 400;
const ASSIST_ISLAND_RECENT_MS = 5_000;
const ASSIST_DENSE_ISLAND_MS = 2_000;
const ASSIST_DENSE_CPS = 5;
const ASSIST_MIN_SUM_D = 0.15;
const MAX_HINT_SEGMENTS = 3;

export const ASSIST_FOCUS_CONSTANTS = {
  staticMs: ASSIST_STATIC_MS,
  sinceFMs: ASSIST_SINCE_F_MS,
  pauseAfterIslandMs: ASSIST_PAUSE_AFTER_ISLAND_MS,
  islandRecentMs: ASSIST_ISLAND_RECENT_MS,
  denseIslandMs: ASSIST_DENSE_ISLAND_MS,
  denseCps: ASSIST_DENSE_CPS,
  minSumD: ASSIST_MIN_SUM_D,
};

/** env（DSH_ASR_API_KEY）> Config；provider 'none' 或缺 apiKey 的网络 provider → asr=null。 */
export function resolveAudioSettings(
  config: AudioPluginConfig,
  intent: IntentDirective | undefined,
  env: NodeJS.ProcessEnv,
): AudioSettings {
  const audioIntent: IntentAudioDirective | undefined = intent?.audio;
  const mode = audioIntent?.mode ?? config.mode;
  if (mode === 'off') {
    return {
      mode: 'off',
      extractSubtitles: false,
      assistFocus: false,
      sliceCodec: config.sliceCodec,
      cacheEnabled: false,
      cacheDir: config.cacheDir,
      graceMs: config.graceMs,
      asr: null,
    };
  }
  const envKey = env.DSH_ASR_API_KEY?.trim();
  const provider = config.asr.provider;
  const needsKey = provider === 'openai_verbose' || provider === 'openai_basic';
  const apiKey = envKey && envKey.length > 0 ? envKey : config.asr.apiKey?.trim() || null;
  const asr =
    provider !== 'none' && (!needsKey || (apiKey !== null && apiKey.length > 0))
      ? {
          provider,
          baseUrl: config.asr.baseUrl?.trim() || null,
          model: config.asr.model?.trim() || null,
          apiKey,
          language: audioIntent?.language ?? config.asr.language?.trim() ?? null,
          timeoutMs: config.asr.timeoutMs,
          maxConcurrency: config.asr.maxConcurrency,
        }
      : null;
  return {
    mode: 'auto',
    extractSubtitles: audioIntent?.extract_subtitles ?? config.extractSubtitles,
    assistFocus: audioIntent?.assist_focus ?? config.assistFocus,
    sliceCodec: config.sliceCodec,
    cacheEnabled: true,
    cacheDir: config.cacheDir,
    graceMs: config.graceMs,
    asr,
  };
}

export interface SidecarDeps {
  videoPath: string;
  probe: ProbeResult;
  ffmpegPath: string;
  settings: AudioSettings;
  tempDir?: string | undefined;
  signal?: AbortSignal | undefined;
  /** 调用方预扫的 VAD 结果（assistFocus 前置扫描复用；null 表示无）。 */
  precomputedVad?: VadResult | null | undefined;
}

export interface SidecarResult {
  context: AudioContextSummary;
  /** 窗口内全部台词段（时间序）。 */
  segments: TranscriptSegment[];
  /** assistFocus 判定输入（窗口绝对 PTS 语音岛 + 语速）。 */
  islands: Array<[number, number]>;
  speechRate: number | null;
}

function emptyContext(status: AudioStatus): AudioContextSummary {
  return {
    status,
    source: null,
    language: null,
    speechRatio: null,
    rmsDb: null,
    speechRateCps: null,
    segmentsInWindow: 0,
    mountedPackets: 0,
    telemetry: { cacheHit: false, chunks: 0, requests: 0, droppedByGuard: 0, costMs: 0 },
  };
}

/**
 * 窗口音频上下文（三级顺位）。
 *
 * deadlineAt 为墙钟时刻（Date.now()）：到达软截止仍有未完成块时返回
 * timeout_skipped/partial，后台继续补缓存（fire-and-forget）。
 */
export async function runAudioSidecar(
  deps: SidecarDeps,
  window: [number, number],
  deadlineAt: number,
): Promise<SidecarResult> {
  const startedAt = Date.now();
  const { probe, settings } = deps;
  if (settings.mode === 'off') return { context: emptyContext('disabled'), segments: [], islands: [], speechRate: null };
  if (probe.audioStreams.length === 0) {
    return { context: emptyContext('no_audio'), segments: [], islands: [], speechRate: null };
  }

  // A0 字幕
  if (settings.extractSubtitles) {
    try {
      const timeline = await loadSubtitleTimeline(deps.videoPath, probe, {
        ffmpegPath: deps.ffmpegPath,
        signal: deps.signal,
      });
      if (timeline.status !== 'none') {
        const segments = sliceSegments(timeline.segments, window);
        let vad: VadResult | null = deps.precomputedVad ?? null;
        if (settings.assistFocus && vad === null) {
          vad = await scanVad(deps.videoPath, window, { ffmpegPath: deps.ffmpegPath, signal: deps.signal });
        }
        const rate = speechRateCps(segments, vad);
        return {
          context: {
            status: 'ok',
            source: timeline.status,
            language: timeline.language,
            speechRatio: vad ? vad.activeRatio : null,
            rmsDb: vad ? vad.rmsDb : null,
            speechRateCps: rate,
            segmentsInWindow: segments.length,
            mountedPackets: 0,
            telemetry: {
              cacheHit: false,
              chunks: 0,
              requests: 0,
              droppedByGuard: 0,
              costMs: Date.now() - startedAt,
            },
          },
          segments,
          islands: vad ? vad.islands : [],
          speechRate: rate,
        };
      }
    } catch {
      // 字幕失败 → 继续声学路径
    }
  }

  // A1 声学
  let vad: VadResult | null = deps.precomputedVad ?? null;
  if (vad === null) {
    try {
      vad = await scanVad(deps.videoPath, window, { ffmpegPath: deps.ffmpegPath, signal: deps.signal });
    } catch {
      vad = null;
    }
  }
  if (isSilentWindow(vad)) {
    return {
      context: {
        ...emptyContext('silent'),
        speechRatio: vad!.activeRatio,
        rmsDb: vad!.rmsDb,
        telemetry: { cacheHit: false, chunks: 0, requests: 0, droppedByGuard: 0, costMs: Date.now() - startedAt },
      },
      segments: [],
      islands: [],
      speechRate: null,
    };
  }
  if (!settings.asr) {
    return {
      context: {
        ...emptyContext('no_subtitle_asr_unconfigured'),
        speechRatio: vad ? vad.activeRatio : null,
        rmsDb: vad ? vad.rmsDb : null,
        telemetry: { cacheHit: false, chunks: 0, requests: 0, droppedByGuard: 0, costMs: Date.now() - startedAt },
      },
      segments: [],
      islands: vad ? vad.islands : [],
      speechRate: null,
    };
  }

  // A2 ASR（软截止）
  try {
    const result = await withDeadline(
      transcribeWindow(deps.videoPath, window, vad, {
        ffmpegPath: deps.ffmpegPath,
        settings: settings.asr,
        cacheDir: settings.cacheDir,
        cacheEnabled: settings.cacheEnabled,
        sliceCodec: settings.sliceCodec,
        tempDir: deps.tempDir,
        signal: deps.signal,
      }),
      deadlineAt,
    );
    const rate = speechRateCps(result.segments, vad);
    const status: AudioStatus = result.failedChunks > 0 ? 'partial' : 'ok';
    return {
      context: {
        status,
        source: 'asr',
        language: settings.asr.language,
        speechRatio: vad ? vad.activeRatio : null,
        rmsDb: vad ? vad.rmsDb : null,
        speechRateCps: rate,
        segmentsInWindow: result.segments.length,
        mountedPackets: 0,
        telemetry: {
          cacheHit: result.cacheHit,
          chunks: result.requests,
          requests: result.requests,
          droppedByGuard: result.droppedByGuard,
          costMs: Date.now() - startedAt,
        },
      },
      segments: result.segments,
      islands: vad ? vad.islands : [],
      speechRate: rate,
    };
  } catch (error) {
    if (error instanceof DeadlineExceededError) {
      return {
        context: {
          ...emptyContext('timeout_skipped'),
          speechRatio: vad ? vad.activeRatio : null,
          rmsDb: vad ? vad.rmsDb : null,
          telemetry: { cacheHit: false, chunks: 0, requests: 0, droppedByGuard: 0, costMs: Date.now() - startedAt },
        },
        segments: [],
        islands: vad ? vad.islands : [],
        speechRate: null,
      };
    }
    return { context: emptyContext('error'), segments: [], islands: vad ? vad.islands : [], speechRate: null };
  }
}

class DeadlineExceededError extends Error {}

function withDeadline<T>(task: Promise<T>, deadlineAt: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      reject(new DeadlineExceededError('audio deadline exceeded'));
      return;
    }
    const timer = setTimeout(() => reject(new DeadlineExceededError('audio deadline exceeded')), remaining);
    task.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// 画布包挂载
// ---------------------------------------------------------------------------

export interface PacketWindow {
  packetId: number;
  startMs: number;
  endMs: number;
  unitIds: Array<{ globalId: number; timestampMs: number }>;
}

/** ±300ms 交集 + 重叠最大归属；跨包段的第二副本加 (cont.) 前缀。 */
export function mountSegments(
  packets: PacketWindow[],
  segments: TranscriptSegment[],
  status: AudioStatus,
  source: AudioSourceKind | null,
  language: string | null,
): Map<number, PacketAudioMount> {
  const mounts = new Map<number, PacketAudioMount>();
  if (packets.length === 0 || segments.length === 0) return mounts;
  /** 每包命中的段与重叠毫秒数（±300ms 余量口径）。 */
  const hitsByPacket = new Map<number, Array<{ seg: TranscriptSegment; overlapMs: number }>>();
  for (const packet of packets) {
    const lo = packet.startMs - MOUNT_MARGIN_MS;
    const hi = packet.endMs + MOUNT_MARGIN_MS;
    const hits: Array<{ seg: TranscriptSegment; overlapMs: number }> = [];
    for (const seg of segments) {
      if (seg.endMs <= lo || seg.startMs >= hi) continue;
      const overlapMs = Math.min(seg.endMs, hi) - Math.max(seg.startMs, lo);
      if (overlapMs <= 0) continue;
      hits.push({ seg, overlapMs });
    }
    if (hits.length > 0) hitsByPacket.set(packet.packetId, hits);
  }
  // 主归属：重叠最大的包；并列时归较早的包
  const owner = new Map<number, number>();
  for (const packet of packets) {
    for (const hit of hitsByPacket.get(packet.packetId) ?? []) {
      const prev = owner.get(hit.seg.segId);
      if (prev === undefined) {
        owner.set(hit.seg.segId, packet.packetId);
        continue;
      }
      const prevHits = hitsByPacket.get(prev) ?? [];
      const prevOverlap = prevHits.find((h) => h.seg.segId === hit.seg.segId)?.overlapMs ?? 0;
      if (hit.overlapMs > prevOverlap) owner.set(hit.seg.segId, packet.packetId);
    }
  }
  for (const packet of packets) {
    const hits = hitsByPacket.get(packet.packetId);
    if (!hits) continue;
    const mounted = [];
    for (const { seg } of hits) {
      const isOwner = owner.get(seg.segId) === packet.packetId;
      if (!isOwner) {
        // 跨包补全：非归属包保留 (cont.) 副本（段在本包窗口开始前已起始）
        const hit = hits.find((h) => h.seg.segId === seg.segId)!;
        const lo = packet.startMs - MOUNT_MARGIN_MS;
        if (hit.overlapMs < CONT_MIN_OVERLAP_MS || seg.startMs >= lo) continue;
        mounted.push({
          segId: seg.segId,
          startMs: Math.max(seg.startMs, packet.startMs - MOUNT_MARGIN_MS),
          endMs: seg.endMs,
          text: `(cont.) ${seg.text}`,
          source: seg.source,
          alignedUnitIds: packet.unitIds
            .filter((u) => u.timestampMs >= seg.startMs - MOUNT_MARGIN_MS && u.timestampMs <= seg.endMs + MOUNT_MARGIN_MS)
            .map((u) => u.globalId)
            .slice(0, 8),
        });
        continue;
      }
      mounted.push({
        segId: seg.segId,
        startMs: seg.startMs,
        endMs: seg.endMs,
        text: seg.text,
        source: seg.source,
        alignedUnitIds: packet.unitIds
          .filter((u) => u.timestampMs >= seg.startMs - MOUNT_MARGIN_MS && u.timestampMs <= seg.endMs + MOUNT_MARGIN_MS)
          .map((u) => u.globalId)
          .slice(0, 8),
      });
    }
    if (mounted.length > 0) mounts.set(packet.packetId, { status, source, language, segments: mounted });
  }
  return mounts;
}

/** 提示行：`Audio @Packet #N: [12.1s-12.9s] "台词" | …(+2 more)`。 */
export function audioHintLine(packetId: number, mount: PacketAudioMount): string {
  const parts = mount.segments.slice(0, MAX_HINT_SEGMENTS).map(
    (seg) => `[${(seg.startMs / 1000).toFixed(1)}s-${(seg.endMs / 1000).toFixed(1)}s] "${seg.text}"`,
  );
  const more = mount.segments.length > MAX_HINT_SEGMENTS ? ` …(+${mount.segments.length - MAX_HINT_SEGMENTS} more)` : '';
  return `Audio @Packet #${packetId}: ${parts.join(' | ')}${more}`;
}

/** 冷区引用行：`[Audio@#N] K segments retained`。 */
export function coldRefAudioHintLine(sourcePacketId: number, count: number): string {
  return `[Audio@#${sourcePacketId}] ${count} segments retained`;
}

// ---------------------------------------------------------------------------
// assistFocus 判定
// ---------------------------------------------------------------------------

export interface AssistContext {
  /** 窗口绝对 PTS 语音岛。 */
  islands: Array<[number, number]>;
  speechRate: number | null;
}

/**
 * 触发条件（全部满足）：
 * STATIC >10s；距上一张 F >3s；Σd_t(自上 F) >0.15；
 * 存在密集语音岛（≥2s 或语速 >5cps），岛结束后 0.4s~5s 处于停顿谷底。
 */
export function assistFocusShouldFire(
  ctx: AssistContext,
  tMs: number,
  staticSinceMs: number,
  lastFMs: number | null,
  sumD: number,
  firedIslandEnd: number | null,
): number | null {
  if (tMs - staticSinceMs < ASSIST_STATIC_MS) return null;
  if (lastFMs !== null && tMs - lastFMs < ASSIST_SINCE_F_MS) return null;
  if (sumD < ASSIST_MIN_SUM_D) return null;
  for (const [a, b] of ctx.islands) {
    const dense = b - a >= ASSIST_DENSE_ISLAND_MS || (ctx.speechRate !== null && ctx.speechRate > ASSIST_DENSE_CPS);
    if (!dense) continue;
    const afterPause = tMs - b;
    if (afterPause >= ASSIST_PAUSE_AFTER_ISLAND_MS && afterPause <= ASSIST_ISLAND_RECENT_MS) {
      if (firedIslandEnd !== null && firedIslandEnd >= b) continue; // 同一岛只触发一次
      return b;
    }
  }
  return null;
}

export function sourceLabel(source: AudioSourceKind | null, language: string | null): string {
  if (source === null) return 'none';
  const kind =
    source === 'external_subtitle' || source === 'embedded_subtitle' ? 'subtitles' : 'asr';
  return language ? `${kind}:${language}` : kind;
}
