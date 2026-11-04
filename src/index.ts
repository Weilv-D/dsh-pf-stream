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
import {
  handleToolCall,
  type AttachedImage,
  type AttachImagesFn,
  type InspectFn,
  type ProbeFn,
  type StreamFn,
  type ToolCallArgs,
  type ToolExec,
  type ToolResult,
} from './tool/handler.js';
import type { PacketArtifact } from './stage4/canvasPacker.js';
import { TOOL_NAME, TOOL_DESCRIPTION, toolOutputSchema, toolParameters } from './tool/schema.js';
import { probeVideo } from './stage0/probe.js';
import { runDeterministicInspection } from './stage3/deterministicRouter.js';
import { runStreamCall } from './tool/streamCall.js';
import { resolveBinPaths } from './utils/ffmpegBin.js';

export const name = 'dsh-pf-stream';

export const inject = ['tools', 'subprocess', 'attachments'];

/** 56 MiB = 58,720,256 字节（含 8 MiB Base64 编码膨胀与协议结构预留）。 */
export const DEFAULT_MAX_REQUEST_BYTES = 56 * 1024 * 1024;

export const Config = Schema.object({
  renderVisualId: Schema.boolean().default(true).description('渲染超像素微型反色角标'),
  maxPacketsPerCall: Schema.number().default(64).description('单次调用画布包数上限'),
  maxFramesPerCall: Schema.number().default(128).description('确定性抽帧单次目标帧数上限（frame_count 受此钳制）'),
  maxImagesPerCall: Schema.number().default(20).description('单次调用回传图像上限（宿主单条消息图像上限 20）'),
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

/** 宿主附件服务返回的引用（@deepseek-ai/dsh-attachment 口径）。 */
export interface AttachmentServiceRef {
  attachmentId: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * 宿主附件服务；运行时由 inject=['attachments'] 保证存在。
 *
 * 提交原始 PNG 字节，服务负责校验、规范化与落盘，返回可直接放进
 * 图像内容块 `{type:'image', attachment}` 的引用。
 */
export interface AttachmentsService {
  saveImages(
    inputs: Array<{ data: Uint8Array; mediaType: string; name?: string }>,
  ): Promise<AttachmentServiceRef[]>;
}

/** 结构化宿主上下文：cordis Context 加 tools 服务。 */
export type HostContext = Context & { tools: ToolsService };

type ContentBlock = { type: 'text'; text: string } | { type: 'image'; attachment: AttachedImage };

/** 从 cordis 上下文取附件服务（测试替身可能没有 get）。 */
function resolveAttachments(ctx: HostContext): AttachmentsService | undefined {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get;
  if (typeof get !== 'function') return undefined;
  const service = get.call(ctx, 'attachments');
  if (service === undefined || service === null) return undefined;
  return service as AttachmentsService;
}

/**
 * 画布包 PNG 提交给宿主附件服务。
 *
 * 宿主单条消息有图像张数上限（缺省 20），超出时保留最新包，旧包只回元数据。
 * 返回值与 artifacts 按索引对齐，未提交的槽位为 undefined。
 */
async function savePacketImages(
  attachments: AttachmentsService | undefined,
  artifacts: PacketArtifact[],
  limit: number,
): Promise<Array<AttachedImage | undefined>> {
  if (attachments === undefined || artifacts.length === 0) return [];
  const keep = Math.max(1, Math.min(Math.trunc(limit) || 1, artifacts.length));
  const start = artifacts.length - keep;
  const inputs = artifacts.slice(start).map((artifact) => ({
    data: artifact.imageBytes,
    mediaType: 'image/png',
    name: `pf-packet-${artifact.packet.packetId}.png`,
  }));
  const refs = await attachments.saveImages(inputs);
  if (refs.length !== inputs.length) {
    throw new Error(
      `attachment service returned ${refs.length} references for ${inputs.length} canvases; ` +
        'refusing to return a partial result',
    );
  }
  const aligned: Array<AttachedImage | undefined> = new Array<AttachedImage | undefined>(artifacts.length);
  refs.forEach((ref, index) => {
    aligned[start + index] = {
      attachmentId: String(ref.attachmentId),
      mediaType: String(ref.mediaType),
      bytes: Math.round(Number(ref.bytes) || 0),
      width: Math.round(Number(ref.width) || 0),
      height: Math.round(Number(ref.height) || 0),
    };
  });
  return aligned;
}

/**
 * 工具结果 → 模型可见内容块：一段完整 JSON 文本 + 每张画布一张真图。
 *
 * 宿主把 render 的返回值直接当 content 数组使用，并调用 content.some(...)，
 * 因此必须返回内容块数组（单个块对象会在消费侧抛 TypeError）。
 */
export function renderContent(value: unknown): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  const packets = (value as { packets?: unknown }).packets;
  if (!Array.isArray(packets)) return blocks;
  for (const packet of packets) {
    const image = (packet as { image?: unknown }).image as AttachedImage | undefined;
    if (image !== undefined && image !== null && typeof image.attachmentId === 'string') {
      blocks.push({ type: 'image', attachment: image });
    }
  }
  return blocks;
}

export function buildToolDefinition(_deps: { ctx: HostContext; config: PfStreamPluginConfig }) {
  const { config } = _deps;
  const bins = resolveBinPaths({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath });
  const attachments = resolveAttachments(_deps.ctx);
  const attachImages: AttachImagesFn = (artifacts) =>
    savePacketImages(attachments, artifacts, config.maxImagesPerCall);
  const probe: ProbeFn = (videoPath, signal) =>
    probeVideo(videoPath, { ffprobePath: bins.ffprobe, signal });
  const inspect: InspectFn = (videoPath, probeResult, intent, signal) =>
    runDeterministicInspection(videoPath, probeResult, intent, {
      ffmpegPath: bins.ffmpeg,
      ffprobePath: bins.ffprobe,
      renderVisualId: config.renderVisualId,
      packetIdStart: 1,
      globalIdStart: 1,
      appliedIntentId: 'intent_1',
      maxRequestBytes: config.maxRequestBytes,
      maxTokensPerImage: config.meteringProfile.maxTokensPerImage,
      maxTokensBudget: intent.max_tokens_budget ?? config.maxTokensBudgetPerCall,
      signal,
    });
  const stream: StreamFn = (videoPath, probeResult, intent, sessionId, signal) =>
    runStreamCall(videoPath, probeResult, intent, sessionId ?? 'default', {
      ffmpegPath: bins.ffmpeg,
      ffprobePath: bins.ffprobe,
      renderVisualId: config.renderVisualId,
      defaultStreamWindowMs: config.defaultStreamWindowMs,
      streamWorkMaxEdge: config.streamWorkMaxEdge,
      maxPacketsPerCall: config.maxPacketsPerCall,
      maxTokensBudgetPerCall: config.maxTokensBudgetPerCall,
      maxRequestBytes: config.maxRequestBytes,
      maxColdRefs: config.maxColdRefs,
      epochCompactionWindow: config.epochCompactionWindow,
      imageCountTiersEnabled: config.meteringProfile.imageCountTiersEnabled,
      maxTokensPerImage: config.meteringProfile.maxTokensPerImage,
      signal,
    });
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: toolParameters,
    output: {
      schema: toolOutputSchema,
      // 宿主把 render 的返回值直接当 content 使用，并调用 content.some(...)，
      // 因此必须返回内容块数组（单个块对象会在消费侧抛 TypeError）。
      render: (_args: unknown, value: unknown) => renderContent(value),
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    // 同一 (sessionId, videoKey) 的调用经 per-key promise 队列串行化，
    // 会话级状态使并发不安全。
    isConcurrencySafe: () => false,
    async execute(args: ToolCallArgs, exec: ToolExec | undefined): Promise<ToolResult> {
      return handleToolCall(args, exec, {
        probe,
        inspect,
        stream,
        attachImages,
        limits: {
          maxPackets: config.maxPacketsPerCall,
          maxTokensBudget: config.maxTokensBudgetPerCall,
          maxFrames: config.maxFramesPerCall,
        },
      });
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
