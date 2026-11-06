/**
 * 历史便捷字段归一化（《五、双层自适应调节与统一参数映射》§1.1）。
 *
 * 输入便利层：start_time/end_time/time_range/timestamps/fps/interval/num_frames/
 * frame_count/crop/bbox/roi/probe_only → 标准 IntentDirective 字段。
 * 判秒规则（《技术设计方案》§2.4）：无后缀数值 ≤ 时长（秒）×2 判秒，超过判毫秒；
 * 归一化来源记入 normalizedFrom。
 */

import type { IntentDirective, RoiHint } from '../types.js';

export interface NormalizedIntent {
  intent: IntentDirective;
  /** 触发了归一化的来源字段名列表（审计与 normalized_from 元数据用）。 */
  normalizedFrom: string[];
}

/** 数值或字符串时间 → 毫秒（判秒规则见模块注释）。 */
export function toMs(value: number | string, durationMs: number): number {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (!Number.isFinite(n)) throw new Error(`时间值无法解析：${String(value)}`);
  const secThreshold = (durationMs / 1000) * 2;
  const ms = n <= secThreshold ? n * 1000 : n;
  return Math.round(ms);
}

/**
 * ROI 归一化：归一化坐标直接钳制 [0,1]；像素坐标（任一分量 >1）
 * 按显示宽高换算为归一化坐标（规格《五》§1.1 crop/bbox/roi 规则）。
 * 非有限分量按 0 处理（静默全灰帧的 NaN 面在此截断；标准 intent.roi_hint
 * 的严格拒绝在 adapter.clampRoi）。
 */
function normalizeRoi(
  raw: { x: number; y: number; w: number; h: number },
  displayWidth: number,
  displayHeight: number,
): RoiHint {
  const finiteOrZero = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const x0 = finiteOrZero(raw.x);
  const y0 = finiteOrZero(raw.y);
  const w0 = finiteOrZero(raw.w);
  const h0 = finiteOrZero(raw.h);
  const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
  const pixelMode = x0 > 1 || y0 > 1 || w0 > 1 || h0 > 1;
  const x = pixelMode ? x0 / displayWidth : x0;
  const y = pixelMode ? y0 / displayHeight : y0;
  const w = pixelMode ? w0 / displayWidth : w0;
  const h = pixelMode ? h0 / displayHeight : h0;
  return {
    x: clamp01(x),
    y: clamp01(y),
    w: Math.min(Math.max(w, 0), 1 - clamp01(x)),
    h: Math.min(Math.max(h, 0), 1 - clamp01(y)),
  };
}

export function normalizeLegacyArgs(
  args: Record<string, unknown>,
  durationMs: number,
  display: { width: number; height: number } = { width: 1, height: 1 },
  maxFrames = 128,
): NormalizedIntent {
  const intent: IntentDirective = {};
  const normalizedFrom: string[] = [];
  const has = (k: string) => Object.prototype.hasOwnProperty.call(args, k) && args[k] !== undefined;

  if (has('start_time') || has('end_time') || has('time_range')) {
    const start = has('start_time') ? toMs(args['start_time'] as number | string, durationMs) : 0;
    const end = has('end_time')
      ? toMs(args['end_time'] as number | string, durationMs)
      : Math.max(start, durationMs);
    intent.pts_window = [start, end];
    normalizedFrom.push('start_time/end_time');
  }
  if (has('time_range') && Array.isArray(args['time_range']) && args['time_range'].length === 2) {
    const [a, b] = args['time_range'] as Array<number | string>;
    if (a !== undefined && b !== undefined) {
      intent.pts_window = [toMs(a, durationMs), toMs(b, durationMs)];
      normalizedFrom.push('time_range');
    }
  }
  if (has('timestamps') && Array.isArray(args['timestamps'])) {
    intent.timestamps_ms = (args['timestamps'] as Array<number | string>).map((t) => toMs(t, durationMs));
    intent.action = 'timestamps';
    normalizedFrom.push('timestamps');
  }
  if (has('fps')) {
    const fps = Number(args['fps']);
    if (Number.isFinite(fps) && fps > 0) {
      intent.interval_ms = Math.round(1000 / fps);
      intent.action = 'uniform';
      normalizedFrom.push('fps');
    }
  }
  if (has('interval')) {
    const iv = Number(args['interval']);
    if (Number.isFinite(iv) && iv > 0) {
      intent.interval_ms = toMs(iv, durationMs);
      intent.action = 'uniform';
      normalizedFrom.push('interval');
    }
  }
  if (has('num_frames') || has('frame_count')) {
    const fc = Number(args['num_frames'] ?? args['frame_count']);
    if (Number.isFinite(fc) && fc >= 1) {
      intent.frame_count = Math.min(Math.round(fc), maxFrames);
      if (intent.action == null) intent.action = 'uniform';
      normalizedFrom.push('num_frames/frame_count');
    }
  }
  const roiRaw = (args['crop'] ?? args['bbox'] ?? args['roi']) as
    | { x: number; y: number; w: number; h: number }
    | undefined;
  if (roiRaw && typeof roiRaw === 'object') {
    intent.roi_hint = normalizeRoi(roiRaw, display.width, display.height);
    normalizedFrom.push('crop/bbox/roi');
  }
  if (args['probe_only'] === true) {
    intent.action = 'probe';
    normalizedFrom.push('probe_only');
  }
  return { intent, normalizedFrom };
}
