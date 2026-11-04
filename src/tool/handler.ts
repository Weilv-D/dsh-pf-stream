/**
 * 工具调用 action 路由。
 *
 * 依据规格《五、双层自适应调节与统一参数映射》§1.1 历史便捷字段归一化规则：
 * probe_only 映射为 action="probe"；未声明 action 时默认 pf_stream。
 */

import type { IntentDirective, LegacyInspectionParams, ProbeResult } from '../types.js';
import { PfStreamError } from '../errors.js';

export { PfStreamError } from '../errors.js';

export interface ToolCallArgs {
  video_path: string;
  intent?: Partial<IntentDirective> & LegacyInspectionParams;
  [legacy: string]: unknown;
}

export interface ToolExec {
  signal: AbortSignal;
}

export type ToolResult = Record<string, unknown>;

/** probe 通道实现，由插件入口注入（便于测试替换）。 */
export type ProbeFn = (videoPath: string, signal: AbortSignal | undefined) => Promise<ProbeResult>;

export interface ToolDeps {
  probe: ProbeFn;
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
  throw new PfStreamError('PFSTREAM_ACTION_UNAVAILABLE', `action '${action}' 通道不可用`);
}
