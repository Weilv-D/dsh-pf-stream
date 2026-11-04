/**
 * 工具调用 action 路由。
 *
 * 依据规格《五、双层自适应调节与统一参数映射》§1.1 历史便捷字段归一化规则：
 * probe_only 映射为 action="probe"；未声明 action 时默认 pf_stream。
 * M1 起 timestamps / uniform 由确定性检视通道承载。
 */

import type { IntentDirective, LegacyInspectionParams, ProbeResult } from '../types.js';
import { PfStreamError } from '../errors.js';
import type { InspectionResult } from '../stage3/deterministicRouter.js';
import type { StreamCallResult } from './streamCall.js';

export { PfStreamError } from '../errors.js';

export interface ToolCallArgs {
  video_path: string;
  intent?: Partial<IntentDirective> & LegacyInspectionParams;
  [legacy: string]: unknown;
}

export interface ToolExec {
  signal: AbortSignal;
  /** 宿主会话标识（缺省聚合到 'default'）。 */
  sessionId?: string | undefined;
}

export type ToolResult = Record<string, unknown>;

/** probe 通道实现，由插件入口注入（便于测试替换）。 */
export type ProbeFn = (videoPath: string, signal: AbortSignal | undefined) => Promise<ProbeResult>;

/** 确定性检视通道实现，由插件入口注入。 */
export type InspectFn = (
  videoPath: string,
  probe: ProbeResult,
  intent: IntentDirective,
  signal: AbortSignal | undefined,
) => Promise<InspectionResult>;

/** 流式通道实现，由插件入口注入。 */
export type StreamFn = (
  videoPath: string,
  probe: ProbeResult,
  intent: IntentDirective,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
) => Promise<StreamCallResult>;

export interface ToolDeps {
  probe: ProbeFn;
  inspect?: InspectFn | undefined;
  stream?: StreamFn | undefined;
}

export function resolveAction(args: ToolCallArgs): NonNullable<IntentDirective['action']> {
  if (args.intent?.action) return args.intent.action;
  if (args.intent?.probe_only === true || args.probe_only === true) return 'probe';
  return 'pf_stream';
}

export async function handleToolCall(
  args: ToolCallArgs,
  exec: ToolExec | undefined,
  deps: ToolDeps,
): Promise<ToolResult> {
  const action = resolveAction(args);
  if (action === 'probe') {
    const probeResult = await deps.probe(args.video_path, exec?.signal);
    return { action: 'probe', probe: probeResult };
  }
  if (action === 'timestamps' || action === 'uniform') {
    if (!deps.inspect) {
      throw new PfStreamError('PFSTREAM_ACTION_UNAVAILABLE', `action '${action}' 通道不可用`);
    }
    const probeResult = await deps.probe(args.video_path, exec?.signal);
    const intent = (args.intent ?? {}) as IntentDirective;
    const inspection = await deps.inspect(args.video_path, probeResult, intent, exec?.signal);
    return {
      action,
      probe: probeResult,
      packets: inspection.packets.map((p) => p.packet),
      hintLines: inspection.hintLines,
    };
  }
  if (action === 'pf_stream') {
    if (!deps.stream) {
      throw new PfStreamError('PFSTREAM_ACTION_UNAVAILABLE', `action '${action}' 通道不可用`);
    }
    const probeResult = await deps.probe(args.video_path, exec?.signal);
    const intent = (args.intent ?? {}) as IntentDirective;
    const stream = await deps.stream(args.video_path, probeResult, intent, exec?.sessionId, exec?.signal);
    return {
      action: 'pf_stream',
      probe: probeResult,
      packets: stream.packets.map((p) => p.packet),
      hintLines: stream.hintLines,
      heartbeats: stream.heartbeats,
      telemetry: stream.telemetry,
      session: { intentId: stream.sessionIntentId },
    };
  }
  throw new PfStreamError('PFSTREAM_ACTION_UNAVAILABLE', `action '${action}' 通道不可用`);
}
