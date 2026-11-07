/**
 * 视听融合（Audio-Transcript Sidecar）共享类型。
 *
 * 术语：
 * - 通道（source）：字幕（外挂/内嵌）或 ASR 转写；
 * - 覆盖区间（interval）：磁盘转写缓存中已完成的 [startMs, endMs] 片段；
 * - 挂载（mount）：把台词段映射到某个画布包（±300ms 交集 + 中心归属）。
 */

import type { HostSpeechService } from '../asr/hostSpeech.js';

export type AudioSourceKind = 'external_subtitle' | 'embedded_subtitle' | 'asr';

export type AudioStatus =
  | 'ok'
  | 'partial'
  | 'silent'
  | 'no_audio'
  | 'disabled'
  | 'no_subtitle_asr_unconfigured'
  | 'timeout_skipped'
  | 'error';

/** 台词段（PTS 毫秒，全片时间轴）。 */
export interface TranscriptSegment {
  segId: number;
  startMs: number;
  endMs: number;
  text: string;
  source: AudioSourceKind;
  /** ASR 置信度线索（字幕为 null）。 */
  noSpeechProb?: number | undefined;
  avgLogprob?: number | undefined;
  compressionRatio?: number | undefined;
}

/** 字幕轨道定位结果（A0）。 */
export interface SubtitleTimeline {
  status: 'external_subtitle' | 'embedded_subtitle' | 'none';
  language: string | null;
  segments: TranscriptSegment[];
}

/** 声学扫描结果（A1）。 */
export interface VadResult {
  /** 静音区间（窗口内，PTS 毫秒）。 */
  silence: Array<[number, number]>;
  /** 语音活跃岛（窗口内，PTS 毫秒）。 */
  islands: Array<[number, number]>;
  /** 窗口均方根电平（dBFS；探测失败为 null）。 */
  rmsDb: number | null;
  /** 窗口峰值电平（dBFS；探测失败为 null）。 */
  peakDb: number | null;
  /** 活跃占比（0-1）。 */
  activeRatio: number;
}

export type AsrProviderKind = 'openai_verbose' | 'openai_basic' | 'local_cli' | 'host_sensevoice';

/** ASR 运行时设置（env > Config 解析后的产物）。 */
export interface AsrSettings {
  provider: AsrProviderKind;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  language: string | null;
  /** local_cli 附加参数：{audio}/{out} 令牌；无 {audio} 时音频路径追加末尾。 */
  args: readonly string[] | null;
  /** 单请求超时（毫秒）。 */
  timeoutMs: number;
  /** 并发上限。 */
  maxConcurrency: number;
  /** host_sensevoice 专用：官方 speechToText 服务句柄（不写入配置/缓存）。 */
  hostService?: HostSpeechService | null | undefined;
}

/** 音频通道运行时设置（Config + intent 合并后的产物）。 */
export interface AudioSettings {
  mode: 'auto' | 'off';
  extractSubtitles: boolean;
  assistFocus: boolean;
  sliceCodec: 'mp3' | 'opus';
  cacheEnabled: boolean;
  cacheDir: string;
  /** 视觉结果返回前的音频宽限（毫秒）。 */
  graceMs: number;
  asr: AsrSettings | null;
}

/** 插件 Config 的 audio 块（schemavery 填充后的形态）。 */
export interface AudioPluginConfig {
  mode: 'auto' | 'off';
  extractSubtitles: boolean;
  assistFocus: boolean;
  sliceCodec: 'mp3' | 'opus';
  cacheDir: string;
  graceMs: number;
  asr: {
    /** 引擎选择：auto/local/cloud/host/off/legacy；缺省按 auto 解释。 */
    engine?: string | undefined;
    /** 云端服务商预设 id（openai/groq/custom）。 */
    preset?: string | undefined;
    provider: AsrProviderKind | 'none';
    baseUrl: string | undefined;
    model: string | undefined;
    apiKey: string | undefined;
    language: string | undefined;
    /** local_cli 附加参数（置于音频文件参数前；支持 {audio}/{out} 令牌）。 */
    args: string[] | undefined;
    /** 本地转写引擎（0.3.0 托管安装）：可执行文件/模型路径与线程数。 */
    local?:
      | {
          binPath?: string | undefined;
          modelPath?: string | undefined;
          modelId?: string | undefined;
          threads?: number | undefined;
          /** 本地转写单请求超时（毫秒）；CPU 转写远慢于云端。 */
          timeoutMs?: number | undefined;
        }
      | undefined;
    timeoutMs: number;
    maxConcurrency: number;
  };
}

/** 意图层的 audio 子对象（schema 展示给模型的最小面）。 */
export interface IntentAudioDirective {
  mode?: 'auto' | 'off';
  language?: string;
  extract_subtitles?: boolean;
  assist_focus?: boolean;
}

/** 单次窗口的音频上下文（工具返回根级 audio 字段）。 */
export interface AudioContextSummary {
  status: AudioStatus;
  source: AudioSourceKind | null;
  language: string | null;
  speechRatio: number | null;
  rmsDb: number | null;
  speechRateCps: number | null;
  segmentsInWindow: number;
  mountedPackets: number;
  telemetry: {
    cacheHit: boolean;
    chunks: number;
    requests: number;
    droppedByGuard: number;
    costMs: number;
    /** ASR 块失败原因采样（≤5 条异常 message 原文；缺省 = 无失败或未走 ASR 路径）。 */
    failureSamples?: string[] | undefined;
  };
}

/** 画布包级挂载结果（packets[].audio 字段与冷区引用行数据源）。 */
export interface PacketAudioMount {
  status: AudioStatus;
  source: AudioSourceKind | null;
  language: string | null;
  /** 挂载段（alignedUnitIds：±300ms 相交的画布单元；冷区引用可缺省）。 */
  segments: Array<TranscriptSegment & { alignedUnitIds?: number[] | undefined }>;
}
