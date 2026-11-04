/**
 * Stage 2 —— 硬切（SWITCH）与极速甩镜解耦（规格《三》§2）。
 *
 * H_switch = 0.10 为固定常量，与动态调节的 H_high_eff 解耦；
 * ≥ 26 块（> 80%）满足 δ_raw > 0.30 或 δ > 0.30 时进入直方图判据：
 * D_hist ≥ 0.35 → 场景硬切；D_hist < 0.35 → 极速甩镜（维持/切入 MOTION）。
 */

export const H_SWITCH = 0.1;
export const SWITCH_BLOCK_THRESHOLD = 0.3;
export const SWITCH_MIN_BLOCKS = 26;
export const SWITCH_HIST_L1 = 0.35;

export type SwitchVerdict = 'none' | 'SWITCH' | 'WHIP';

export function classifySceneChange(
  switchCandidateBlocks: number,
  histL1: number,
): SwitchVerdict {
  if (switchCandidateBlocks < SWITCH_MIN_BLOCKS) return 'none';
  return histL1 >= SWITCH_HIST_L1 ? 'SWITCH' : 'WHIP';
}

/**
 * 黑场/过曝帧判定（SWITCH 原子步骤 6 顺延条件）：
 * μ_I < 0.05 或 μ_I > 0.95 且 σ_I < 0.01。
 */
export function isBlackOrBlownFrame(gray: Float64Array): boolean {
  let mean = 0;
  for (let i = 0; i < gray.length; i++) mean += gray[i]!;
  mean /= gray.length;
  if (mean >= 0.05 && mean <= 0.95) return false;
  let variance = 0;
  for (let i = 0; i < gray.length; i++) variance += (gray[i]! - mean) ** 2;
  variance /= gray.length;
  return Math.sqrt(variance) < 0.01;
}
