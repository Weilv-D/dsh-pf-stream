/**
 * pf_stream 通道编排：会话意图合并 → runStreamPass → 游标与序号回写。
 *
 * M2 范围：进程内会话状态；发包 history_mode 恒为 'initial'
 * （两级历史引用在 M4 接入，接入时不改写本编排的发包路径）。
 */

import { runStreamPass, type StreamRunResult } from '../stage3/streamSampler.js';
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
  signal?: AbortSignal | undefined;
}

export interface StreamCallResult extends StreamRunResult {
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

  return { ...result, sessionIntentId: merged.intentId, appliedIntentId: merged.intentId };
}

/** 供 handler 输出遥测的基准参数（不触发解码）。 */
export function describeBaselines(intent: IntentDirective): ReturnType<typeof baselinesFromIntent> {
  return baselinesFromIntent(intent.mode ?? 'standard', intent.focus ?? 'balanced');
}
