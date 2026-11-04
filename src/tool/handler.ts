/**
 * 工具调用 action 路由。
 *
 * 依据规格《五、双层自适应调节与统一参数映射》§1.1 历史便捷字段归一化规则：
 * probe_only 映射为 action="probe"；未声明 action 时默认 pf_stream。
 */

import type { IntentDirective, LegacyInspectionParams } from '../types.js';

/** 插件参数化错误码命名空间：PFSTREAM_<模块>_<原因>。 */
export class PfStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PfStreamError';
  }
}

export interface ToolCallArgs {
  video_path: string;
  intent?: Partial<IntentDirective> & LegacyInspectionParams;
  [legacy: string]: unknown;
}

export interface ToolExec {
  signal: AbortSignal;
}

export type ToolResult = Record<string, unknown>;

export function resolveAction(args: ToolCallArgs): NonNullable<IntentDirective['action']> {
  if (args.intent?.action) return args.intent.action;
  if (args.intent?.probe_only === true || args.probe_only === true) return 'probe';
  return 'pf_stream';
}

export async function handleToolCall(args: ToolCallArgs, _exec: ToolExec | undefined): Promise<ToolResult> {
  const action = resolveAction(args);
  throw new PfStreamError('PFSTREAM_ACTION_UNAVAILABLE', `action '${action}' 通道不可用`);
}
