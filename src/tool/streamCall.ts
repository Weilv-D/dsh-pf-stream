/**
 * pf_stream 通道编排：会话意图合并 → runStreamPass → 两级历史引用 → 预检门控。
 *
 * 发包路径：冷区 FORM_3 锚点引用（Epoch 内固定）→ 热区全条带引用 → 当前增量包；
 * 预检超限时按 旧冷区 → 旧热区 → 增量尾部 顺序截断（规格《六》§2）。
 */

import { runStreamPass, type StreamRunResult } from '../stage3/streamSampler.js';
import { timelineHintLine, type PacketArtifact } from '../stage4/canvasPacker.js';
import {
  coldRefHintLine,
  compactEpoch,
  HOT_WINDOW,
  planHistoryRefs,
  recordPackets,
} from '../stage6/history.js';
import {
  precheckBundle,
  type BundleItem,
  type BundleKind,
  type PrecheckResult,
} from '../stage6/precheck.js';
import { baselinesFromIntent, mergeSessionIntent, sessionIntentChanged } from '../stage5/intent.js';
import { fingerprintOf, getSessionState, getVideoSlot } from '../session/state.js';
import { persistSession, restoreSessionIfAbsent } from '../session/persistence.js';
import type { IntentDirective, ProbeResult } from '../types.js';
import {
  audioHintLine,
  coldRefAudioHintLine,
  mountSegments,
  runAudioSidecar,
} from '../audio/sidecar.js';
import { scanVad } from '../audio/acousticVad.js';
import type {
  AudioContextSummary,
  AudioSettings,
  PacketAudioMount,
  TranscriptSegment,
} from '../audio/types.js';

export interface StreamCallOptions {
  ffmpegPath: string;
  /** 末帧探测与定点索引用的 ffprobe；缺省由 ffmpegPath 同目录派生。 */
  ffprobePath?: string | undefined;
  renderVisualId: boolean;
  defaultStreamWindowMs: number;
  streamWorkMaxEdge: number;
  maxPacketsPerCall: number;
  maxTokensBudgetPerCall: number;
  /** 单次推进墙钟上限（毫秒）；透传给采样器墙钟逃逸门。 */
  maxWallClockMsPerCall: number;
  /** 请求字节水位（Base64 编码后口径）。 */
  maxRequestBytes: number;
  maxColdRefs: number;
  /** Epoch Compaction 窗口（新包数）。 */
  epochCompactionWindow: number;
  imageCountTiersEnabled: boolean;
  /** 单图视觉 Token 上限（meteringProfile 口径，缺省不校验）。 */
  maxTokensPerImage?: number | undefined;
  /** 音频台词侧车（缺省关闭；零侵入视觉主链路）。 */
  audio?: { settings: AudioSettings; ffmpegPath: string; tempDir?: string | undefined } | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * 预检结果的 JSON 安全投影。
 *
 * `PrecheckResult.kept[].artifact` 持有 PNG `Buffer`（imageBytes/anchorBytes），
 * 直接并入工具返回值会让宿主 `snapshotToolValue` 判为
 * “value is not lossless JSON” 并拒绝整次调用；因此遥测只回显引用标识与计量。
 */
export interface PrecheckSummary {
  kept: Array<{ kind: BundleKind; packetId: number }>;
  dropped: Array<{ kind: BundleKind; packetId: number }>;
  truncatedCurrent: boolean;
  encodedBytes: number;
  tokens: number;
}

export interface StreamCallResult extends Omit<StreamRunResult, 'telemetry'> {
  telemetry: StreamRunResult['telemetry'] & { precheck: PrecheckSummary };
  /** 冷区引用数（Epoch 固定复用）。 */
  coldRefCount: number;
  /** 热区引用数。 */
  hotRefCount: number;
  sessionIntentId: string;
  appliedIntentId: string;
  /** 音频侧车上下文摘要（无音频/关闭时 status='no_audio'|'disabled'）。 */
  audio: AudioContextSummary;
  /** 按包挂载的台词（仅含实际有台词的包）。 */
  audioByPacket: Record<number, PacketAudioMount>;
}

/**
 * 会话级串行化：同一 sessionId 的流式调用按 promise 链排队执行。
 *
 * 会话状态（packetSeq/intentSeq/历史环/游标）为进程内存态，两次并发调用会读到
 * 同一快照并各自分配相同序号（packetId 重复）。宿主侧 isConcurrencySafe=false
 * 已声明串行语义，此队列作为插件内的第二道防线（防御直接并发调用 execute）。
 */
const sessionLocks = new Map<string, Promise<unknown>>();

export function runStreamCall(
  videoPath: string,
  probe: ProbeResult,
  intent: IntentDirective,
  sessionId: string,
  options: StreamCallOptions,
): Promise<StreamCallResult> {
  const tail = sessionLocks.get(sessionId) ?? Promise.resolve();
  const task = tail
    .catch(() => undefined)
    .then(() => runStreamCallLocked(videoPath, probe, intent, sessionId, options));
  const sentinel = task.then(
    () => undefined,
    () => undefined,
  );
  sessionLocks.set(sessionId, sentinel);
  void sentinel.finally(() => {
    if (sessionLocks.get(sessionId) === sentinel) sessionLocks.delete(sessionId);
  });
  return task;
}

async function runStreamCallLocked(
  videoPath: string,
  probe: ProbeResult,
  intent: IntentDirective,
  sessionId: string,
  options: StreamCallOptions,
): Promise<StreamCallResult> {
  // 落盘恢复先于内存访问（会话不存在时从 storageDomain 快照重建）；
  // 在 per-session 串行锁内执行，与同会话的落盘写入天然互斥。
  restoreSessionIfAbsent(sessionId);
  const session = getSessionState(sessionId);
  const fingerprint = fingerprintOf(videoPath);
  const slot = getVideoSlot(session, fingerprint);

  // 意图层：字段级合并到 session_intent（规格《五》§1.3）；
  // 会话意图实际变化时才递增 intentSeq（probe/重复调用不产生新 intentId）。
  const prevIntent = session.intent;
  const merged = mergeSessionIntent(prevIntent, intent, {
    mode: 'standard',
    focus: 'balanced',
  });
  if (sessionIntentChanged(prevIntent, merged) || session.intentSeq === 0) {
    session.intentSeq += 1;
  }
  merged.intentId = `intent_${session.intentSeq}`;
  session.intent = merged;

  // 音频侧车（零侵入）：assistFocus 需要在解码前拿到语音岛 → 先做一次
  // VAD 预扫（本地 ffmpeg，窗口量级毫秒级），全量侧车与解码并行。
  const audio = options.audio;
  const windowMs = intent.pts_window
    ? Math.max(1, intent.pts_window[1] - intent.pts_window[0])
    : options.defaultStreamWindowMs;
  const lastPts = probe.lastPtsMs;
  const windowStart = Math.min(
    Math.max(0, intent.pts_window?.[0] ?? slot.cursor.lastConsumedPtsMs),
    lastPts,
  );
  const windowEnd = Math.min(windowStart + windowMs, lastPts);
  const audioWindow: [number, number] | null = windowEnd > windowStart ? [windowStart, windowEnd] : null;
  let preVad = null;
  const audioEnabled =
    audio !== undefined &&
    audio.settings.mode !== 'off' &&
    audioWindow !== null &&
    probe.audioStreams.length > 0;
  if (audioEnabled && audio.settings.assistFocus) {
    try {
      preVad = await scanVad(videoPath, audioWindow, {
        ffmpegPath: audio.ffmpegPath,
        signal: options.signal,
      });
    } catch {
      preVad = null;
    }
  }
  const sidecarPromise =
    audioEnabled && audio
      ? runAudioSidecar(
          {
            videoPath,
            probe,
            ffmpegPath: audio.ffmpegPath,
            settings: audio.settings,
            tempDir: audio.tempDir,
            signal: options.signal,
            precomputedVad: preVad,
          },
          audioWindow,
          Date.now() + audio.settings.graceMs,
        ).catch(() => null)
      : null;

  const result = await runStreamPass(videoPath, probe, merged, slot.cursor, {
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
    renderVisualId: options.renderVisualId,
    windowMs,
    windowStartMs: intent.pts_window?.[0],
    streamWorkMaxEdge: options.streamWorkMaxEdge,
    maxPackets: intent.max_packets ?? options.maxPacketsPerCall,
    maxTokensBudget: intent.max_tokens_budget ?? options.maxTokensBudgetPerCall,
    wallClockBudgetMs: options.maxWallClockMsPerCall,
    appliedIntentId: merged.intentId,
    packetIdStart: session.packetSeq + 1,
    globalIdStart: session.globalUnitSeq + 1,
    heartbeatSeqStart: session.heartbeatSeq + 1,
    audioAssist:
      audioEnabled && preVad !== null
        ? { islands: preVad.islands, speechRate: null }
        : undefined,
    signal: options.signal,
  });

  slot.cursor = result.nextCursor;
  session.packetSeq = result.counters.packetSeq;
  session.globalUnitSeq = result.counters.globalUnitSeq;
  session.heartbeatSeq = result.counters.heartbeatSeq;

  // 音频侧车收尾（软截止内完成则挂载；超时/失败折叠为非 ok 状态）
  const sidecar = sidecarPromise !== null ? await sidecarPromise : null;
  const newPacketWindows = result.packets.map((artifact) => {
    const units = artifact.packet.units;
    const times = units.map((u) => u.timestampMs);
    return {
      packetId: artifact.packet.packetId,
      startMs: times.length > 0 ? Math.min(...times) : 0,
      endMs: times.length > 0 ? Math.max(...times) : 0,
      unitIds: units.map((u) => ({ globalId: u.globalId, timestampMs: u.timestampMs })),
    };
  });
  const newMounts =
    sidecar !== null && sidecar.segments.length > 0 && result.packets.length > 0
      ? mountSegments(
          newPacketWindows,
          sidecar.segments,
          sidecar.context.status,
          sidecar.context.source,
          sidecar.context.language,
        )
      : new Map<number, PacketAudioMount>();
  const audioSegmentsByPacket = new Map<number, TranscriptSegment[]>();
  for (const [pid, mount] of newMounts) {
    audioSegmentsByPacket.set(
      pid,
      mount.segments.map((s) => ({
        segId: s.segId,
        startMs: s.startMs,
        endMs: s.endMs,
        text: s.text,
        source: s.source,
      })),
    );
  }

  // Stage 6：热区引用取自本次记录之前的历史环尾部（热区=上一次调用的包），
  // 再记录新包 → Epoch 收敛 → 冷区规划 → 预检门控
  const hot = planHistoryRefs(slot, merged.intentId).hot;
  recordPackets(slot, session, result.packets, audioSegmentsByPacket);
  compactEpoch(
    slot,
    session,
    {
      hotWindow: HOT_WINDOW,
      maxColdRefs: options.maxColdRefs,
      epochWindow: options.epochCompactionWindow,
    },
    () => {
      session.packetSeq += 1;
      return session.packetSeq;
    },
    merged.intentId,
  );
  const { cold } = planHistoryRefs(slot, merged.intentId);

  // 本次增量包被 Epoch 收编为冷区引用时，原始条带不再重复输出
  // （规格《六》§3：按最终包龄输出冷区 FORM_3 与热区条带，每包只出现一次）。
  const newPacketIds = new Set(result.packets.map((a) => a.packet.packetId));
  const absorbedNewIds = new Set(
    slot.epoch.coldRefs
      .map((c) => c.sourcePacketId)
      .filter((id) => newPacketIds.has(id)),
  );
  const incremental = result.packets.filter((a) => !absorbedNewIds.has(a.packet.packetId));

  const items: BundleItem[] = [
    ...cold.map((artifact) => ({ kind: 'cold' as const, artifact })),
    ...hot.map((artifact) => ({ kind: 'hot' as const, artifact })),
    ...incremental.map((artifact) => ({ kind: 'new' as const, artifact })),
  ];
  const precheck = precheckBundle(items, {
    maxRequestBytes: options.maxRequestBytes,
    maxPackets: intent.max_packets ?? options.maxPacketsPerCall,
    maxTokensBudget: intent.max_tokens_budget ?? options.maxTokensBudgetPerCall,
    imageCountTiersEnabled: options.imageCountTiersEnabled,
    maxTokensPerImage: options.maxTokensPerImage,
  });

  // 输出顺序：冷区（旧→新）→ 热区（旧→新）→ 增量（时序）
  const keptPackets: PacketArtifact[] = precheck.kept.map((it) => it.artifact);
  const newIdSet = new Set(
    precheck.kept.filter((it) => it.kind === 'new').map((it) => it.artifact.packet.packetId),
  );
  const keptHintLines: string[] = [];
  for (const it of precheck.kept) {
    if (it.kind === 'cold') {
      const plan = slot.epoch.coldRefs.find(
        (c) => c.refPacketId === it.artifact.packet.packetId,
      );
      if (plan) {
        keptHintLines.push(coldRefHintLine(plan));
        if (plan.audioSegments !== undefined && plan.audioSegments.length > 0) {
          keptHintLines.push(coldRefAudioHintLine(plan.sourcePacketId, plan.audioSegments.length));
        }
      }
    } else if (it.kind === 'hot') {
      keptHintLines.push(timelineHintLine(it.artifact.packet, merged.roiHint ?? null));
    }
  }
  // 增量提示行与 result.packets 同序 1:1（采样器每次 push 相邻执行）；
  // 仅保留预检后仍在输出的增量包提示行
  result.packets.forEach((artifact, i) => {
    const line = result.hintLines[i];
    if (line !== undefined && newIdSet.has(artifact.packet.packetId)) keptHintLines.push(line);
  });
  // 台词行紧跟对应增量包提示行（时序）
  for (const it of precheck.kept) {
    if (it.kind !== 'new') continue;
    const mount = newMounts.get(it.artifact.packet.packetId);
    if (mount) keptHintLines.push(audioHintLine(it.artifact.packet.packetId, mount));
  }

  // 冷区引用的台词挂载（Epoch 内 100% 保留）
  const audioByPacket: Record<number, PacketAudioMount> = {};
  for (const [pid, mount] of newMounts) {
    if (newIdSet.has(pid)) audioByPacket[pid] = mount;
  }
  for (const it of precheck.kept) {
    if (it.kind !== 'cold') continue;
    const plan = slot.epoch.coldRefs.find(
      (c) => c.refPacketId === it.artifact.packet.packetId,
    );
    if (plan !== undefined && plan.audioSegments !== undefined && plan.audioSegments.length > 0) {
      audioByPacket[plan.refPacketId] = {
        status: 'ok',
        source: null,
        language: null,
        segments: plan.audioSegments,
      };
    }
  }

  const audioContext: AudioContextSummary =
    sidecar !== null
      ? sidecar.context
      : {
          status: audio !== undefined && audio.settings.mode === 'off' ? 'disabled' : 'no_audio',
          source: null,
          language: null,
          speechRatio: null,
          rmsDb: null,
          speechRateCps: null,
          segmentsInWindow: 0,
          mountedPackets: Object.keys(audioByPacket).length,
          telemetry: { cacheHit: false, chunks: 0, requests: 0, droppedByGuard: 0, costMs: 0 },
        };
  audioContext.mountedPackets = Object.keys(audioByPacket).length;

  // 成功路径落盘：快照写穿（put 在后端确认持久后才 resolve）后再返回结果，
  // 重启后续接点不回退。失败路径不落盘（失败调用在内存中也只提前合并了
  // 意图，快照以最近一次成功调用为准）。
  await persistSession(session);

  return {
    ...result,
    packets: keptPackets,
    hintLines: keptHintLines,
    telemetry: { ...result.telemetry, precheck: summarizePrecheck(precheck) },
    coldRefCount: precheck.kept.filter((it) => it.kind === 'cold').length,
    hotRefCount: precheck.kept.filter((it) => it.kind === 'hot').length,
    sessionIntentId: merged.intentId,
    appliedIntentId: merged.intentId,
    audio: audioContext,
    audioByPacket,
  };
}

/** 预检结果 → 无损 JSON 投影（剔除 PNG Buffer 载体）。 */
function summarizePrecheck(precheck: PrecheckResult): PrecheckSummary {
  return {
    kept: precheck.kept.map((it) => ({ kind: it.kind, packetId: it.artifact.packet.packetId })),
    dropped: precheck.dropped.map((it) => ({ kind: it.kind, packetId: it.packetId })),
    truncatedCurrent: precheck.truncatedCurrent,
    encodedBytes: precheck.encodedBytes,
    tokens: precheck.tokens,
  };
}

/** 供 handler 输出遥测的基准参数（不触发解码）。 */
export function describeBaselines(intent: IntentDirective): ReturnType<typeof baselinesFromIntent> {
  return baselinesFromIntent(intent.mode ?? 'standard', intent.focus ?? 'balanced');
}
