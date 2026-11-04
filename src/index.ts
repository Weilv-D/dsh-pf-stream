/**
 * dsh-pf-stream — DeepSeek Harness 视频感知插件入口。
 *
 * 统一 action 路由：动态流式采样（pf_stream）与内建确定性检视
 * （probe / timestamps / uniform / RoI）共用主工具 dsh-pf-stream。
 *
 * 工具表稳定性（Prefix KV-Cache）：tools.register 在 apply 期一次装齐、
 * dispose 期统一注销，运行中不增删。
 */

import Schema from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { PfStreamPluginConfig } from './types.js';
import { handleToolCall, type ToolCallArgs, type ToolExec, type ToolResult } from './tool/handler.js';
import { TOOL_NAME, TOOL_DESCRIPTION, toolOutputSchema, toolParameters } from './tool/schema.js';

export const name = 'dsh-pf-stream';

export const inject = ['tools', 'subprocess'];

/** 56 MiB = 58,720,256 字节（含 8 MiB Base64 编码膨胀与协议结构预留）。 */
export const DEFAULT_MAX_REQUEST_BYTES = 56 * 1024 * 1024;

export const Config = Schema.object({
  renderVisualId: Schema.boolean().default(true).description('渲染超像素微型反色角标'),
  maxPacketsPerCall: Schema.number().default(64).description('单次调用画布包数上限'),
  maxTokensBudgetPerCall: Schema.number().default(65536).description('单次调用视觉 Token 预算上限（intent.max_tokens_budget 受此钳制）'),
  maxRequestBytes: Schema.number().default(DEFAULT_MAX_REQUEST_BYTES).description('请求字节软水位'),
  maxColdRefs: Schema.number().default(4).description('冷区引用数量上限'),
  telemetryEnabled: Schema.boolean().default(true).description('遥测开关'),
  ffmpegPath: Schema.string().description('ffmpeg 可执行文件路径（缺省自动探测）'),
  ffprobePath: Schema.string().description('ffprobe 可执行文件路径（缺省自动探测）'),
  tempDir: Schema.string().description('临时目录（缺省系统临时目录）'),
  contentHashFallback: Schema.boolean().default(false).description('内容哈希降级轨开关'),
  defaultStreamWindowMs: Schema.number().default(10000).description('流式窗口缺省长度（毫秒）'),
  streamWorkMaxEdge: Schema.number().default(2048).description('流式解码工作分辨率长边上限'),
  epochCompactionWindow: Schema.number().default(6).description('热转冷批量收敛窗口（包数）'),
  meteringProfile: Schema.object({
    superpixelPx: Schema.const(42).description('超像素边长（像素）'),
    rounding: Schema.const('ceil').description('计费序列长度取整方式'),
    maxTokensPerImage: Schema.number().default(1024).description('单图视觉 Token 上限（v4.1 口径 1024；384 为 legacy 枚举位）'),
    maxImagesPerRequest: Schema.number().default(600).description('单次请求图像张数上限（代际参数）'),
    imageCountTiersEnabled: Schema.boolean().default(false).description('≥15 图单边 4096px 规则门控'),
    legacyModes: Schema.array(String).default([]).description('legacy 计量口径枚举位'),
  }),
});

/** 流式单次调用阻塞上限：宿主死线减 40s 余量（超时协作式，signal 绝不硬终止）。 */
export const TOOL_TIMEOUT_MS = 900_000;
export const SELF_MANAGED_BLOCK_CEILING_MS = TOOL_TIMEOUT_MS - 40_000;

/** 宿主 tools 服务；运行时由 inject=['tools'] 保证存在（类型未随 cordis 包发布）。 */
export interface ToolsService {
  register(definition: unknown): () => void;
}

/** 结构化宿主上下文：cordis Context 加 tools 服务。 */
export type HostContext = Context & { tools: ToolsService };

export function buildToolDefinition(_deps: { ctx: HostContext; config: PfStreamPluginConfig }) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: toolParameters,
    output: {
      schema: toolOutputSchema,
      render: (_args: unknown, value: unknown) => ({
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      }),
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    // 同一 (sessionId, videoKey) 的调用经 per-key promise 队列串行化，
    // 会话级状态使并发不安全。
    isConcurrencySafe: () => false,
    async execute(args: ToolCallArgs, exec: ToolExec | undefined): Promise<ToolResult> {
      return handleToolCall(args, exec);
    },
  };
}

export function apply(ctx: Context, config: PfStreamPluginConfig) {
  const host = ctx as HostContext;
  const dispose = host.tools.register(buildToolDefinition({ ctx: host, config }));
  // register 返回的 disposer 为主注销路径；'dispose' 事件为兜底
  // （经 events 服务注册，事件名不受 keyof Events 约束）。
  ctx.events.on('dispose', () => {
    try {
      dispose();
    } catch {
      // 卸载期清理失败不再抛出
    }
  });
}
