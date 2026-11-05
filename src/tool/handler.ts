/**
 * 工具调用 action 路由。
 *
 * 依据规格《五、双层自适应调节与统一参数映射》§1.1 历史便捷字段归一化规则：
 * probe_only 映射为 action="probe"；未声明 action 时默认 pf_stream。
 * M1 起 timestamps / uniform 由确定性检视通道承载。
 */

import type { IntentDirective, LegacyInspectionParams, ProbeResult } from '../types.js';
import { PfStreamError } from '../errors.js';
import { adaptCallArgs } from '../entry/adapter.js';
import type { InspectionResult } from '../stage3/deterministicRouter.js';
import type { PacketArtifact } from '../stage4/canvasPacker.js';
import type { StreamCallResult } from './streamCall.js';
import type { AudioSettings, SubtitleTimeline } from '../audio/types.js';

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
  /**
   * 宿主 ToolExec 的 agent 投影（dsh-tools 语义：exec.agent.session 为当前会话）。
   * 宿主未提供顶层 sessionId 时按 agent.session.id 取会话标识。
   */
  agent?: { session?: { id?: string | undefined } } | undefined;
}

/** 会话标识解析：顶层 sessionId 优先，其次宿主 agent.session.id，缺省聚合 'default'。 */
export function resolveSessionId(exec: ToolExec | undefined): string | undefined {
  return exec?.sessionId ?? exec?.agent?.session?.id;
}

export type ToolResult = Record<string, unknown>;

/** 宿主图像内容块引用的 JSON 投影（只含宿主 schema 允许的字段）。 */
export interface AttachedImage {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
}

/**
 * 画布包 PNG → 宿主附件引用。
 *
 * 返回值与入参 artifacts 按索引对齐；未提交的槽位为 undefined。
 * 入口层未挂载 attachments 服务时返回空数组，工具退化为纯元数据结果。
 */
export type AttachImagesFn = (artifacts: PacketArtifact[]) => Promise<Array<AttachedImage | undefined>>;

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

export interface AudioToolDeps {
  /** 按调用意图解析音频设置（env > Config > intent 覆盖）。 */
  resolveSettings(intent: IntentDirective | undefined): AudioSettings;
  /** 软失败的字幕时间线加载（无字幕/失败返回 null，不抛错）。 */
  subtitlesFor(
    videoPath: string,
    probe: ProbeResult,
    signal: AbortSignal | undefined,
  ): Promise<SubtitleTimeline | null>;
}

export interface ToolDeps {
  probe: ProbeFn;
  inspect?: InspectFn | undefined;
  stream?: StreamFn | undefined;
  /** 宿主附件回传（可选：缺省时只返回画布元数据）。 */
  attachImages?: AttachImagesFn | undefined;
  /** 音频台词侧车（可选：缺省时 probe 不带字幕导航）。 */
  audio?: AudioToolDeps | undefined;
  /** 入口适配器钳制上限（缺省用插件默认配置值）。 */
  limits?: { maxPackets: number; maxTokensBudget: number; maxFrames: number } | undefined;
}

export function resolveAction(args: ToolCallArgs): NonNullable<IntentDirective['action']> {
  if (args.intent?.action) return args.intent.action;
  if (args.intent?.probe_only === true || args.probe_only === true) return 'probe';
  return 'pf_stream';
}

/** 给发包元数据补上 `image` 附件引用；无引用时只回显元数据。 */
async function withPacketImages(
  artifacts: PacketArtifact[],
  attachImages: AttachImagesFn | undefined,
): Promise<ToolResult[]> {
  const refs = attachImages ? await attachImages(artifacts) : [];
  return artifacts.map((artifact, index) => {
    const image = refs[index];
    return image ? { ...artifact.packet, image } : { ...artifact.packet };
  });
}

export async function handleToolCall(
  args: ToolCallArgs,
  exec: ToolExec | undefined,
  deps: ToolDeps,
): Promise<ToolResult> {
  // 统一入口：video_path 前置校验（空实参时给出明确错误码，而非 probe 的
  // 文件未找到）→ probe → 入口适配器归一化（历史便捷字段 + 枚举校验 + 钳制）
  // → 按 intent.action 路由（《五》§1 与《七》§1）。
  if (typeof args.video_path !== 'string' || args.video_path.length === 0) {
    throw new PfStreamError('PFSTREAM_ARGS_VIDEO_PATH', 'video_path 必须为非空字符串');
  }
  const probeResult = await deps.probe(args.video_path, exec?.signal);
  const { intent } = adaptCallArgs(args as unknown as Record<string, unknown>, {
    lastPtsMs: probeResult.lastPtsMs,
    displayWidth: probeResult.displayWidth,
    displayHeight: probeResult.displayHeight,
    maxPackets: deps.limits?.maxPackets ?? 64,
    maxTokensBudget: deps.limits?.maxTokensBudget ?? 65536,
    maxFrames: deps.limits?.maxFrames ?? 128,
  });
  const action = intent.action ?? 'pf_stream';

  if (action === 'probe') {
    const result: ToolResult = { action: 'probe', probe: probeResult };
    const settings = deps.audio?.resolveSettings(intent);
    if (settings?.extractSubtitles) {
      const timeline = await deps.audio!.subtitlesFor(args.video_path, probeResult, exec?.signal);
      if (timeline) {
        result.subtitles = {
          source: timeline.status,
          language: timeline.language,
          segments: timeline.segments.map((s) => ({
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
          })),
        };
      }
    }
    return result;
  }
  if (action === 'timestamps' || action === 'uniform') {
    if (!deps.inspect) {
      throw new PfStreamError('PFSTREAM_ACTION_UNAVAILABLE', `action '${action}' 通道不可用`);
    }
    const inspection = await deps.inspect(args.video_path, probeResult, intent, exec?.signal);
    const packets = await withPacketImages(inspection.packets, deps.attachImages);
    return {
      action,
      probe: probeResult,
      packets,
      hintLines: inspection.hintLines,
    };
  }
  if (action === 'pf_stream') {
    if (!deps.stream) {
      throw new PfStreamError('PFSTREAM_ACTION_UNAVAILABLE', `action '${action}' 通道不可用`);
    }
    const stream = await deps.stream(args.video_path, probeResult, intent, resolveSessionId(exec), exec?.signal);
    const packets = await withPacketImages(stream.packets, deps.attachImages);
    const audioByPacket = stream.audioByPacket;
    const packetsWithAudio = audioByPacket
      ? packets.map((p) => {
          const mount = audioByPacket[p.packetId as number];
          return mount ? { ...p, audio: mount } : p;
        })
      : packets;
    return {
      action: 'pf_stream',
      probe: probeResult,
      packets: packetsWithAudio,
      hintLines: stream.hintLines,
      heartbeats: stream.heartbeats,
      telemetry: stream.telemetry,
      audio: stream.audio,
      session: { intentId: stream.sessionIntentId },
    };
  }
  throw new PfStreamError('PFSTREAM_ACTION_UNAVAILABLE', `action '${action}' 通道不可用`);
}
