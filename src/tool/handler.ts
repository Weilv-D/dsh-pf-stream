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

/**
 * probe 全片字幕导航的段数上限：字幕无 Token 计量，超长视频全量回传会
 * 撑爆工具结果文本块；按时间序保留前 500 段（正常对话密度 ≈ 40 分钟），
 * 超出部分以 truncatedSegments 计数告知，细节走 pf_stream 分段获取。
 */
const MAX_PROBE_SUBTITLE_SEGMENTS = 500;

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
    maxPackets: deps.limits?.maxPackets ?? 20,
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
        const sorted = [...timeline.segments].sort((a, b) => a.startMs - b.startMs);
        const segments = sorted.slice(0, MAX_PROBE_SUBTITLE_SEGMENTS);
        result.subtitles = {
          source: timeline.status,
          language: timeline.language,
          segments: segments.map((s) => ({
            startMs: s.startMs,
            endMs: s.endMs,
            text: s.text,
          })),
          ...(sorted.length > segments.length
            ? { truncatedSegments: sorted.length - segments.length }
            : {}),
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
    let packets: ToolResult[];
    try {
      packets = await withPacketImages(stream.packets, deps.attachImages);
    } catch (error) {
      // 附件回传失败：回滚本次内存推进（游标/序号/历史环/快照全部还原到
      // 调用前），下一调用从同一游标重新消费该窗口——「失败调用零状态副作用」。
      // 并发守卫（mutationSeq）在 rollback 内部：期间有后续调用推进则跳过。
      // 回滚自身异常不掩盖原始投递错误（快照往返在本进程生成，失败仅理论可能）。
      try {
        stream.rollback?.();
      } catch {
        // 回滚失败保持原样：内存态以最近一次成功 commit 为准，见覆盖守卫
      }
      throw error;
    }
    // 附件回传成功后才提交落盘（失败路径不落盘；put 写穿后才 resolve，失败
    // 不抛出）。落盘时点从 streamCall 内部后移到此处，游标推进跨重启的可见性
    // 以「投递成功」为准。
    if (stream.commit !== undefined) await stream.commit();
    const audioByPacket = stream.audioByPacket;
    const packetsWithAudio = audioByPacket
      ? packets.map((p) => {
          const mount = audioByPacket[p.packetId as number];
          return mount ? { ...p, audio: mount } : p;
        })
      : packets;
    // 缺少转写引擎时给一句可行动的说明：结果里只有状态码，模型不知道该去哪配置。
    const hintLines = [...stream.hintLines];
    if (stream.audio?.status === 'no_subtitle_asr_unconfigured') {
      hintLines.push(
        '未生成转写文本：该视频没有字幕，且未配置转写引擎。' +
          '可在左侧栏「插件」→「视频理解」中下载本地转写模型（约 190 MB），或配置云端服务商密钥。',
      );
    }
    if (stream.telemetry.stopReason === 'budget_tokens') {
      hintLines.push(
        `已达 max_tokens_budget 预算（本次发出 ${stream.packets.length} 包），本次推进提前停止；` +
          '已消费窗口不会回放，下次调用将从当前游标继续；需要更多内容时提高 max_tokens_budget 后重新调用。',
      );
    }
    if (stream.telemetry.stopReason === 'wall_clock') {
      hintLines.push(
        `已达单次调用墙钟上限（本次推进 ${stream.packets.length} 包后停止）；` +
          '窗口跨度过大时解码会先于预算门触及墙钟。请用 pts_window 分段推进（建议单窗跨度 ≤240s），' +
          '下次调用将从当前游标继续。',
      );
    }
    if (stream.telemetry.stopReason === 'budget_packets') {
      hintLines.push(
        `已达单次调用包数上限（本次推进 ${stream.packets.length} 包后停止）；` +
          '请缩小 pts_window 或分批调用，下次调用将从当前游标继续。',
      );
    }
    return {
      action: 'pf_stream',
      probe: probeResult,
      packets: packetsWithAudio,
      hintLines,
      heartbeats: stream.heartbeats,
      telemetry: stream.telemetry,
      audio: stream.audio,
      session: { intentId: stream.sessionIntentId },
    };
  }
  throw new PfStreamError('PFSTREAM_ACTION_UNAVAILABLE', `action '${action}' 通道不可用`);
}
