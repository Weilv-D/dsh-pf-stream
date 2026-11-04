/**
 * Stage 5（意图层）—— IntentDirective → 流式基准参数映射（规格《五》§1.2）。
 *
 * 自闭环微调（R1-R4）在 M3 接入；本模块仅产出意图基准生效值：
 * S_base/T_cool_base/T_settle_base/H_high_base/T_max_m + ρ_min。
 * 生效区间硬边界：S∈[0.06,0.30]，T_cool∈[800,3000]，T_settle∈[80,500]，H_high∈[0.04,0.20]。
 */

import type { ControlParams, DensityMode, FocusBias, IntentDirective, SessionIntent } from '../types.js';

export interface StreamBaselines extends ControlParams {
  /** MOTION 超时上限 T_max_m（ms）。 */
  tMaxMEff: number;
  /** PEAK 候选判定阈值 ρ_min（detail ×0.8）。 */
  rhoMin: number;
}

export const S_RANGE: [number, number] = [0.06, 0.3];
export const T_COOL_RANGE: [number, number] = [800, 3000];
export const T_SETTLE_RANGE: [number, number] = [80, 500];
export const H_HIGH_RANGE: [number, number] = [0.04, 0.2];
export const RHO_MIN_DEFAULT = 1.05;

export function clamp(v: number, [lo, hi]: [number, number]): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 意图基准参数（mode × focus 叠加规则）。 */
export function baselinesFromIntent(mode: DensityMode, focus: FocusBias): StreamBaselines {
  let sBase: number;
  let tCoolBase: number;
  let tMaxM: number;
  switch (mode) {
    case 'dense':
      sBase = 0.08;
      tCoolBase = 2500;
      tMaxM = 1000;
      break;
    case 'sparse':
      sBase = 0.25;
      tCoolBase = 1000;
      tMaxM = 2000;
      break;
    default:
      sBase = 0.15;
      tCoolBase = 1500;
      tMaxM = 1500;
  }
  let tSettleBase = 200;
  let rhoMin = RHO_MIN_DEFAULT;
  switch (focus) {
    case 'motion':
      sBase = sBase * 0.8;
      tSettleBase = 250;
      break;
    case 'detail':
      tSettleBase = 120;
      rhoMin = RHO_MIN_DEFAULT * 0.8;
      break;
    default:
      tSettleBase = 200;
  }
  sBase = clamp(sBase, S_RANGE);
  const hHighBase = 0.1;
  return {
    SBase: sBase,
    STarget: sBase,
    SEff: sBase,
    TCoolBase: tCoolBase,
    TCoolEff: clamp(tCoolBase, T_COOL_RANGE),
    TSettleBase: tSettleBase,
    TSettleEff: clamp(tSettleBase, T_SETTLE_RANGE),
    HHighBase: hHighBase,
    HHighEff: clamp(hHighBase, H_HIGH_RANGE),
    tMaxMEff: tMaxM,
    rhoMin,
  };
}

/** 会话意图字段级合并（规格《五》§1.3）：sessionIntent ← intent（未传字段保持）。 */
export function mergeSessionIntent(
  current: SessionIntent,
  intent: IntentDirective | undefined,
  defaults: { mode: DensityMode; focus: FocusBias },
): SessionIntent {
  if (!intent) return current;
  // reset 先行（规格《五》§1.3：重置后合并本次新字段），
  // 再按字段级合并覆盖，保证 {reset:true, mode:'dense'} 不丢 dense。
  const base: SessionIntent = intent.reset
    ? {
        intentId: current.intentId,
        mode: defaults.mode,
        focus: defaults.focus,
        fullFrame: false,
      }
    : current;
  const next: SessionIntent = {
    ...base,
    mode: intent.mode ?? base.mode,
    focus: intent.focus ?? base.focus,
    fullFrame: intent.full_frame ?? base.fullFrame,
  };
  if (intent.roi_hint) next.roiHint = intent.roi_hint;
  else if (intent.reset) next.roiHint = undefined;
  return next;
}

/** 会话意图是否发生变化（用于 intentId 递增判定）。 */
export function sessionIntentChanged(a: SessionIntent, b: SessionIntent): boolean {
  return (
    a.mode !== b.mode ||
    a.focus !== b.focus ||
    a.fullFrame !== b.fullFrame ||
    JSON.stringify(a.roiHint ?? null) !== JSON.stringify(b.roiHint ?? null)
  );
}
