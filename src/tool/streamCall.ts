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
import { baselinesFromIntent, mergeSessionIntent } from '../stage5/intent.js';
import { fingerprintOf, getSessionState, getVideoSlot } from '../session/state.js';
import type { IntentDirective, ProbeResult } from '../types.js';

export interface StreamCallOptions {
  ffmpegPath: string;
  renderVisualId: boolean;
  defaultStreamWindowMs: number;
  streamWorkMaxEdge: number;
  maxPacketsPerCall: number;
  maxTokensBudgetPerCall: number;
  /** 请求字节水位（Base64 编码后口径）。 */
  maxRequestBytes: number;
  maxColdRefs: number;
  /** Epoch Compaction 窗口（新包数）。 */
  epochCompactionWindow: number;
  imageCountTiersEnabled: boolean;
  /** 单图视觉 Token 上限（meteringProfile 口径，缺省不校验）。 */
  maxTokensPerImage?: number | undefined;
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
}

export async function runStreamCall(
  videoPath: string,
  probe: ProbeResult,
  intent: IntentDirective,
  sessionId: string,
  options: StreamCallOptions,
): Promise<StreamCallResult> {
  const session = getSessionState(sessionId);
  const fingerprint = fingerprintOf(videoPath);
  const slot = getVideoSlot(session, fingerprint);

  // 意图层：字段级合并到 session_intent（规格《五》§1.3）
  session.intentSeq += 1;
  const merged = mergeSessionIntent(session.intent, intent, {
    mode: 'standard',
    focus: 'balanced',
  });
  merged.intentId = `intent_${session.intentSeq}`;
  session.intent = merged;

  const result = await runStreamPass(videoPath, probe, merged, slot.cursor, {
    ffmpegPath: options.ffmpegPath,
    renderVisualId: options.renderVisualId,
    windowMs: intent.pts_window
      ? Math.max(1, intent.pts_window[1] - intent.pts_window[0])
      : options.defaultStreamWindowMs,
    windowStartMs: intent.pts_window?.[0],
    streamWorkMaxEdge: options.streamWorkMaxEdge,
    maxPackets: intent.max_packets ?? options.maxPacketsPerCall,
    maxTokensBudget: intent.max_tokens_budget ?? options.maxTokensBudgetPerCall,
    appliedIntentId: merged.intentId,
    packetIdStart: session.packetSeq + 1,
    globalIdStart: session.globalUnitSeq + 1,
    heartbeatSeqStart: session.heartbeatSeq + 1,
    signal: options.signal,
  });

  slot.cursor = result.nextCursor;
  session.packetSeq = result.counters.packetSeq;
  session.globalUnitSeq = result.counters.globalUnitSeq;
  session.heartbeatSeq = result.counters.heartbeatSeq;

  // Stage 6：热区引用取自本次记录之前的历史环尾部（热区=上一次调用的包），
  // 再记录新包 → Epoch 收敛 → 冷区规划 → 预检门控
  const hot = planHistoryRefs(slot, merged.intentId).hot;
  recordPackets(slot, session, result.packets);
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

  const items: BundleItem[] = [
    ...cold.map((artifact) => ({ kind: 'cold' as const, artifact })),
    ...hot.map((artifact) => ({ kind: 'hot' as const, artifact })),
    ...result.packets.map((artifact) => ({ kind: 'new' as const, artifact })),
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
      if (plan) keptHintLines.push(coldRefHintLine(plan));
    } else if (it.kind === 'hot') {
      keptHintLines.push(timelineHintLine(it.artifact.packet, merged.roiHint ?? null));
    }
  }
  for (const line of result.hintLines) {
    // 仅保留预检后仍在输出的增量包提示行（按 packetId 前缀匹配）
    const m = /Packet #(\d+)/.exec(line);
    if (m && newIdSet.has(Number(m[1]))) keptHintLines.push(line);
  }

  return {
    ...result,
    packets: keptPackets,
    hintLines: keptHintLines,
    telemetry: { ...result.telemetry, precheck: summarizePrecheck(precheck) },
    coldRefCount: precheck.kept.filter((it) => it.kind === 'cold').length,
    hotRefCount: precheck.kept.filter((it) => it.kind === 'hot').length,
    sessionIntentId: merged.intentId,
    appliedIntentId: merged.intentId,
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
