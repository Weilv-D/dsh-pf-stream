/**
 * 历史便捷字段归一化（《五、双层自适应调节与统一参数映射》§1.1）。
 *
 * 输入便利层：start_time/end_time/time_range/timestamps/fps/interval/num_frames/
 * frame_count/crop/bbox/roi/probe_only → 标准 IntentDirective 字段。
 * 判秒规则：数值 ≤ 时长（秒）×1.5 判秒，超过判毫秒；归一化来源记入 normalizedFrom。
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
  const secThreshold = (durationMs / 1000) * 1.5;
  const ms = n <= secThreshold ? n * 1000 : n;
  return Math.round(ms);
}

function normalizeRoi(raw: { x: number; y: number; w: number; h: number }): RoiHint {
  const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
  return {
    x: clamp01(raw.x),
    y: clamp01(raw.y),
    w: Math.min(Math.max(raw.w, 0), 1 - clamp01(raw.x)),
    h: Math.min(Math.max(raw.h, 0), 1 - clamp01(raw.y)),
  };
}

export function normalizeLegacyArgs(
  args: Record<string, unknown>,
  durationMs: number,
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
      intent.frame_count = Math.min(Math.round(fc), 128);
      if (intent.action == null) intent.action = 'uniform';
      normalizedFrom.push('num_frames/frame_count');
    }
  }
  const roiRaw = (args['crop'] ?? args['bbox'] ?? args['roi']) as
    | { x: number; y: number; w: number; h: number }
    | undefined;
  if (roiRaw && typeof roiRaw === 'object') {
    intent.roi_hint = normalizeRoi(roiRaw);
    normalizedFrom.push('crop/bbox/roi');
  }
  if (args['probe_only'] === true) {
    intent.action = 'probe';
    normalizedFrom.push('probe_only');
  }
  return { intent, normalizedFrom };
}
