/**
 * 入口适配器：顶层调用参数 → 标准 IntentDirective（含校验与钳制）。
 *
 * 校验规则（《五…》§1.3）：枚举外值拒绝；pts_window/timestamps_ms 钳制 [0, last_pts_ms]；
 * roi_hint 钳制 [0,1]；max_packets/max_tokens_budget 钳制到配置上限。
 */

import { PfStreamError } from '../errors.js';
import type { IntentAudioDirective } from '../audio/types.js';
import type { DensityMode, FocusBias, IntentDirective, RoiHint, StreamAction } from '../types.js';
import { normalizeLegacyArgs, type NormalizedIntent } from './legacyNormalizer.js';

const ACTIONS: ReadonlySet<string> = new Set(['pf_stream', 'timestamps', 'uniform', 'probe']);
const MODES: ReadonlySet<string> = new Set(['dense', 'standard', 'sparse']);
const FOCUS: ReadonlySet<string> = new Set(['motion', 'detail', 'balanced']);

export interface AdapterLimits {
  lastPtsMs: number;
  displayWidth: number;
  displayHeight: number;
  maxPackets: number;
  maxTokensBudget: number;
  /** 确定性抽帧单次目标帧数上限（frame_count 钳制值）。 */
  maxFrames: number;
}

export interface AdaptedCall {
  intent: IntentDirective;
  normalizedFrom: string[];
  videoPath: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function clampRoi(roi: RoiHint): RoiHint {
  // 非有限值拒绝（对照 clampMs 的 isFinite 守卫）：NaN/Infinity 透传到视窗
  // 计算会得到 NaN 几何 → 静默全灰帧，错误远在下游且不可归因。
  for (const v of [roi.x, roi.y, roi.w, roi.h] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new PfStreamError('PFSTREAM_ARGS_ROI', `roi_hint 字段必须为有限数值：${String(v)}`);
    }
  }
  const x = Math.min(Math.max(roi.x, 0), 1);
  const y = Math.min(Math.max(roi.y, 0), 1);
  const w = Math.min(Math.max(roi.w, 1e-9), 1 - x);
  const h = Math.min(Math.max(roi.h, 1e-9), 1 - y);
  return { x, y, w, h };
}

/**
 * 归一化入口参数。args 为宿主传入的工具参数（含顶层历史便捷字段与 intent）。
 */
export function adaptCallArgs(
  args: Record<string, unknown>,
  limits: AdapterLimits,
): AdaptedCall {
  const videoPath = args['video_path'];
  if (typeof videoPath !== 'string' || videoPath.length === 0) {
    throw new PfStreamError('PFSTREAM_ARGS_VIDEO_PATH', 'video_path 必须为非空字符串');
  }

  const legacy: NormalizedIntent = normalizeLegacyArgs(args, limits.lastPtsMs, {
    width: limits.displayWidth,
    height: limits.displayHeight,
  }, limits.maxFrames);
  const rawIntent = isRecord(args['intent']) ? (args['intent'] as Record<string, unknown>) : {};

  const intent: IntentDirective = {};

  // 顶层字段是工具 Schema 的公开入口（TOOL_DESCRIPTION 也按顶层描述）；intent 内字段
  // 优先，顶层次之，历史便捷字段最后。此前只读 rawIntent，导致顶层 action/mode/
  // focus/pts_window/max_packets/audio 被静默忽略。
  const pick = (key: string): unknown => rawIntent[key] ?? args[key];

  const action = (pick('action') ?? legacy.intent.action) as StreamAction | undefined;
  if (action != null) {
    if (!ACTIONS.has(action)) {
      throw new PfStreamError('PFSTREAM_ARGS_ACTION', `action 枚举外值：${String(action)}`);
    }
    intent.action = action;
  }

  const mode = pick('mode') as DensityMode | undefined;
  if (mode != null) {
    if (!MODES.has(mode)) throw new PfStreamError('PFSTREAM_ARGS_MODE', `mode 枚举外值：${String(mode)}`);
    intent.mode = mode;
  }
  const focus = pick('focus') as FocusBias | undefined;
  if (focus != null) {
    if (!FOCUS.has(focus)) throw new PfStreamError('PFSTREAM_ARGS_FOCUS', `focus 枚举外值：${String(focus)}`);
    intent.focus = focus;
  }

  const roiRaw = (pick('roi_hint') ?? legacy.intent.roi_hint) as RoiHint | undefined;
  if (roiRaw != null) {
    intent.roi_hint = clampRoi(roiRaw);
  }
  if (pick('full_frame') === true) intent.full_frame = true;

  const windowRaw = (pick('pts_window') ?? legacy.intent.pts_window) as [number, number] | undefined;
  if (windowRaw != null) {
    if (!Array.isArray(windowRaw) || windowRaw.length !== 2) {
      throw new PfStreamError('PFSTREAM_ARGS_WINDOW', 'pts_window 必须为 [start_ms, end_ms]');
    }
    const w0 = clampMs(windowRaw[0], limits.lastPtsMs);
    const w1 = clampMs(windowRaw[1], limits.lastPtsMs);
    intent.pts_window = [Math.min(w0, w1), Math.max(w0, w1)];
  }

  const tsRaw = (pick('timestamps_ms') ?? legacy.intent.timestamps_ms) as number[] | undefined;
  if (tsRaw != null) {
    if (!Array.isArray(tsRaw) || tsRaw.length < 1) {
      throw new PfStreamError('PFSTREAM_ARGS_TIMESTAMPS', 'timestamps_ms 必须为非空数组');
    }
    // 长度上限与 frame_count 的 maxFrames 钳制同源（规格《五》§1.3 上限钳制）：
    // 时间戳是模型点名的显式点位清单，静默截断会丢失指定时刻——故超限报错
    // 而非钳制（与 frame_count 的"概览意图，钳制保留意图"语义分型）。
    if (tsRaw.length > limits.maxFrames) {
      throw new PfStreamError(
        'PFSTREAM_ARGS_TIMESTAMPS',
        `timestamps_ms 数量 ${tsRaw.length} 超过单次上限 ${limits.maxFrames}（maxFrames），请分段调用`,
      );
    }
    if (intent.action == null) intent.action = 'timestamps';
    intent.timestamps_ms = tsRaw.map((t) => clampMs(t, limits.lastPtsMs));
  }

  const intervalRaw = (pick('interval_ms') ?? legacy.intent.interval_ms) as number | undefined;
  if (intervalRaw != null) {
    if (typeof intervalRaw !== 'number' || !(intervalRaw > 0)) {
      throw new PfStreamError('PFSTREAM_ARGS_INTERVAL', 'interval_ms 必须为正数');
    }
    if (intent.action == null) intent.action = 'uniform';
    intent.interval_ms = intervalRaw;
  }

  const fcRaw = (pick('frame_count') ?? legacy.intent.frame_count) as number | undefined;
  if (fcRaw != null) {
    if (typeof fcRaw !== 'number' || !(fcRaw >= 1)) {
      throw new PfStreamError('PFSTREAM_ARGS_FRAME_COUNT', 'frame_count 必须为 ≥1 整数');
    }
    if (intent.action == null) intent.action = 'uniform';
    intent.frame_count = Math.min(Math.round(fcRaw), limits.maxFrames);
  }

  // max_packets / max_tokens_budget：上下限双向钳制（规格《五》§1.3 上限钳制；
  // 低于有效下限（1 包 / 274 Token）时钳到下限，与工具 Schema 的 minimum 声明一致。
  const mpRaw = pick('max_packets') as number | undefined;
  if (mpRaw != null && typeof mpRaw === 'number' && Number.isFinite(mpRaw)) {
    intent.max_packets = Math.min(Math.max(Math.round(mpRaw), 1), limits.maxPackets);
  }
  const mtbRaw = pick('max_tokens_budget') as number | undefined;
  if (mtbRaw != null && typeof mtbRaw === 'number' && Number.isFinite(mtbRaw)) {
    intent.max_tokens_budget = Math.min(Math.max(Math.round(mtbRaw), 274), limits.maxTokensBudget);
  }
  if (pick('reset') === true) intent.reset = true;

  const audioRaw = pick('audio');
  if (audioRaw != null) {
    if (!isRecord(audioRaw) || Array.isArray(audioRaw)) {
      throw new PfStreamError('PFSTREAM_ARGS_AUDIO', 'audio 必须为对象');
    }
    const audio: IntentAudioDirective = {};
    const audioMode = audioRaw['mode'];
    if (audioMode != null) {
      if (audioMode !== 'auto' && audioMode !== 'off') {
        throw new PfStreamError('PFSTREAM_ARGS_AUDIO', `audio.mode 枚举外值：${String(audioMode)}`);
      }
      audio.mode = audioMode;
    }
    const language = audioRaw['language'];
    if (language != null) {
      if (typeof language !== 'string') {
        throw new PfStreamError('PFSTREAM_ARGS_AUDIO', 'audio.language 必须为字符串');
      }
      const trimmed = language.trim();
      if (trimmed.length > 0) audio.language = trimmed;
    }
    for (const key of ['extract_subtitles', 'assist_focus'] as const) {
      const value = audioRaw[key];
      if (value != null) {
        if (typeof value !== 'boolean') {
          throw new PfStreamError('PFSTREAM_ARGS_AUDIO', `audio.${key} 必须为布尔值`);
        }
        audio[key] = value;
      }
    }
    if (Object.keys(audio).length > 0) intent.audio = audio;
  }

  return { intent, normalizedFrom: legacy.normalizedFrom, videoPath };
}

function clampMs(v: number, lastPtsMs: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new PfStreamError('PFSTREAM_ARGS_PTS', `PTS 值非法：${String(v)}`);
  return Math.min(Math.max(Math.round(n), 0), lastPtsMs);
}
