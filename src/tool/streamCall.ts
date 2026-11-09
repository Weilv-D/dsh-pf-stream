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
  purgeUndeliveredPackets,
  recordPackets,
} from '../stage6/history.js';
import {
  precheckBundle,
  type BundleItem,
  type BundleKind,
  type PrecheckResult,
} from '../stage6/precheck.js';
import { mergeSessionIntent, sessionIntentChanged } from '../stage5/intent.js';
import {
  exportSessionSnapshot,
  fingerprintOf,
  getSessionState,
  getVideoSlot,
  importSessionSnapshot,
  peekSessionState,
  setMemorySession,
} from '../session/state.js';
import {
  ensureSessionPersistenceReady,
  persistSession,
  restoreSessionIfAbsent,
} from '../session/persistence.js';
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
  /** 热区条带引用（含字节）数。 */
  hotRefCount: number;
  sessionIntentId: string;
  appliedIntentId: string;
  /** 音频侧车上下文摘要（无音频/关闭时 status='no_audio'|'disabled'）。 */
  audio: AudioContextSummary;
  /** 按包挂载的台词（仅含实际有台词的包）。 */
  audioByPacket: Record<number, PacketAudioMount>;
  /**
   * 落盘提交：由调用方在附件回传成功后调用（put 写穿后才 resolve）。
   * 投递失败时不调用——本次推进不落盘，快照以最近一次成功投递为准。
   */
  commit: () => Promise<boolean>;
  /**
   * 投递失败回滚：把会话内存态恢复到本次调用前（快照往返），并跳过本次
   * 落盘。「失败调用零状态副作用」——回滚后的下一调用从同一游标重新消费
   * 该窗口（内容可恢复）。仅当期间无后续调用推进（mutationSeq 守卫）时
   * 执行，否则跳过（避免抹掉后续调用状态）；返回是否实际回滚。
   */
  rollback: () => boolean;
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
  // 先等待领域就绪（apply 里的 open 是异步的，首个调用可能早于它完成；
  // 若此处不等，恢复会因 domain 尚未赋值而落空）。恢复在 per-session 串行锁
  // 内执行；落盘写入由 commit 在锁外（附件回传成功后）进行——写前覆盖守卫
  // （persistence.mayOverwriteSnapshot）保证回退谱系不会覆盖磁盘较新快照。
  await ensureSessionPersistenceReady();
  restoreSessionIfAbsent(sessionId);
  const session = getSessionState(sessionId);
  // 回滚点：在首次变更前固化整会话快照 + 变更序号。投递失败时 handler 调
  // rollback() 把内存态恢复到此处——否则失败调用的推进滞留内存，会被下一次
  // 成功调用的 commit 携带落盘，重启后未投递窗口被永久跳过（P2-1 跨调用
  // 携带漏洞），且内存里该窗口内容同样永不交付。快照化成本为每次调用一次
  // 整会话 JSON 序列化（≈1MB 量级，远小于解码耗时，可接受）。
  const rollbackPayload = exportSessionSnapshot(session);
  const rollbackMark = ++session.mutationSeq;
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
  // 再记录新包 → Epoch 收敛 → 冷区规划 → 预检门控。本轮新生包进入保护集：
  // 收敛只吸收「条带已随增量投递过」的包，新生包的条带在本轮以增量包首次
  // 投递，下一轮收敛起才有资格进入冷区（每包条带至少完整交付一次）。
  const newPacketIds = new Set(result.packets.map((a) => a.packet.packetId));
  const hot = planHistoryRefs(slot, merged.intentId).hot;
  recordPackets(slot, session, result.packets, audioSegmentsByPacket);
  compactEpoch(
    slot,
    session,
    {
      hotWindow: HOT_WINDOW,
      maxColdRefs: options.maxColdRefs,
      epochWindow: options.epochCompactionWindow,
      protectIds: newPacketIds,
    },
    () => {
      session.packetSeq += 1;
      return session.packetSeq;
    },
    merged.intentId,
  );
  const { cold } = planHistoryRefs(slot, merged.intentId);

  // 收敛不吸收本轮新生包（protectIds 不变式）：增量条带 100% 投递，
  // 「按包龄输出冷区 FORM_3 与热区条带，每包条带只出现一次」的语义以
  // 「先投递后收编」为前提。此处不再需要收编过滤。
  const incremental = result.packets;

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

  // 字节水位截断的未投递增量包：从历史环与 FUnitCache 摘除（「先投递后收编」
  // 不变式——保留在环中会让这些包在下一轮收敛时被收编为 anchor_only_ref，
  // 模型收到指向从未见过条带的锚点引用）。冷/热引用被截断不影响不变式
  // （它们的条带已投递过）。同时给出可行动提示行（此前只有 telemetry 可见）。
  const droppedNewIds = new Set(
    precheck.dropped.filter((d) => d.kind === 'new').map((d) => d.packetId),
  );
  const purgedCount = purgeUndeliveredPackets(slot, session, droppedNewIds);
  let truncationHint: string | null = null;
  if (purgedCount > 0) {
    const droppedArts = result.packets.filter((a) => droppedNewIds.has(a.packet.packetId));
    const times = droppedArts.flatMap((a) => a.packet.units.map((u) => u.timestampMs));
    const range =
      times.length > 0
        ? `（约 ${(Math.min(...times) / 1000).toFixed(1)}s–${(Math.max(...times) / 1000).toFixed(1)}s）`
        : '';
    truncationHint =
      `字节水位截断：${purgedCount} 个增量包超限未投递并已从历史移除${range}；` +
      '该区间内容不会以冷区引用补发，请用 pts_window 指定该区间分小窗重看。';
  }

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
  // 仅保留预检后仍在输出的增量包，并让台词行紧跟对应包，保持上下文局部性
  result.packets.forEach((artifact, i) => {
    const line = result.hintLines[i];
    if (line === undefined || !newIdSet.has(artifact.packet.packetId)) return;
    keptHintLines.push(line);
    const mount = newMounts.get(artifact.packet.packetId);
    if (mount) keptHintLines.push(audioHintLine(artifact.packet.packetId, mount));
  });

  // 单帧/零帧视频（末帧 PTS=0）：流式通道无可发包（单帧不足以组包），
  // 给可行动指引而非静默空结果。
  if (truncationHint !== null) keptHintLines.push(truncationHint);
  if (
    result.telemetry.stopReason === 'end_of_stream' &&
    keptPackets.length === 0 &&
    probe.lastPtsMs === 0
  ) {
    keptHintLines.push(
      '该视频仅含单帧或零帧（末帧 PTS=0）：流式通道没有可发包。' +
        "请改用 action='timestamps'，timestamps_ms=[0] 检视该帧。",
    );
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

  // 落盘改为「投递成功后提交」：本函数只产出结果与 commit 闭包，handler 在
  // 附件回传（savePacketImages 可抛）成功后才调用 commit——这样「失败路径
  // 不落盘」对整次工具调用成立。配合 rollback：附件回传失败时把内存推进也
  // 一并撤回，重启续接点与内容交付完全对齐（磁盘与内存同以成功投递为准）。
  const commit = (): Promise<boolean> => persistSession(session);

  let rollbackDone = false;
  const rollback = (): boolean => {
    if (rollbackDone) return false;
    rollbackDone = true;
    // 并发守卫：仅当期间无后续调用推进（同一 session 对象且 mutationSeq 未变）
    // 才执行快照回滚；否则跳过——后续调用已在共享对象上推进，它的成功 commit
    // 会写出含本次推进的完整一致快照（内容单调），跳过回滚避免抹掉其状态。
    if (
      peekSessionState(sessionId) !== session ||
      session.mutationSeq !== rollbackMark
    ) {
      return false;
    }
    setMemorySession(importSessionSnapshot(rollbackPayload));
    return true;
  };

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
    commit,
    rollback,
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
