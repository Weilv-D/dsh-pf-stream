/**
 * Stage 2 —— 施密特四状态机（规格《三》§3）。
 *
 * STATIC / MOTION / SETTLE / SWITCH：
 * - 高阈值 H_high_eff（动态，默认 0.10），低阈值联动 H_low_eff = 0.5×H_high_eff；
 * - SETTLE 满 T_settle_eff（PTS 差值）→ 锁定 F、A←0、转 STATIC，再经 T_merge=50ms 打包；
 * - SWITCH 原子抢占：清积分、清 P 队列、废擂台、EMA 重置 + 3 帧预热、R4 快定格、
 *   捕获 F_switch（黑场顺延由流式引擎执行）、转 STATIC 观察 250ms。
 *
 * 所有时间判定基于 PTS（契约 5）。积分器 A 与擂台归状态机管，
 * 待发 P 队列与 F 编码由 Stage 3 流式采样器执行。
 */

import type { ArenaCandidate, StateKind, StateMachineSnapshot } from '../types.js';

export interface SchmittThresholds {
  hHighEff: number;
  /** T_settle_eff 生效值（R4 时由流式引擎瞬时置 80ms）。 */
  tSettleEff: number;
  tMergeMs: number;
  /** SWITCH 后静态观察窗口（250ms）。 */
  switchStaticMs: number;
}

export type MachineEffect =
  | 'enter_motion'
  | 'settle_enter'
  | 'settle_cancel'
  | 'settle_lock'
  | 'merge_emit'
  | 'switch'
  | 'switch_static_emit'
  | 'switch_motion_void';

export interface MachineStep {
  /** 本步生效的状态（无迁移时为当前态）。 */
  state: StateKind;
  effects: MachineEffect[];
}

export class SchmittMachine {
  state: StateKind = 'STATIC';
  enteredAtPtsMs = 0;
  integratorA = 0;
  gEma = 0;
  emaWarmupLeft = 0;
  settleStartPtsMs: number | null = null;
  /** SETTLE 锁定后的防碎合并窗起点。 */
  mergeStartPtsMs: number | null = null;
  lastAnchorGlobalId: number | null = null;
  /** SWITCH 后静态观察起点与 F_switch 待发标志。 */
  switchStaticSincePtsMs: number | null = null;
  fSwitchPending = false;

  constructor(init?: Partial<StateMachineSnapshot>) {
    if (init) Object.assign(this, init);
  }

  snapshot(): StateMachineSnapshot {
    return {
      state: this.state,
      enteredAtPtsMs: this.enteredAtPtsMs,
      integratorA: this.integratorA,
      gEma: this.gEma,
      emaWarmupLeft: this.emaWarmupLeft,
      settleStartPtsMs: this.settleStartPtsMs,
    };
  }

  /** H_low_eff 联动。 */
  static hLowOf(hHighEff: number): number {
    return 0.5 * hHighEff;
  }

  /**
   * 单帧步进。switchVerdict 由 SwitchDetector 先行判定；
   * settleArena 由流式引擎维护（观察窗内 g 最高帧），settle_lock 时取用。
   */
  step(ptsMs: number, d: number, th: SchmittThresholds, switchVerdict: 'none' | 'SWITCH' | 'WHIP'): MachineStep {
    const effects: MachineEffect[] = [];
    const hLow = SchmittMachine.hLowOf(th.hHighEff);

    if (switchVerdict === 'SWITCH') {
      // 原子抢占（步骤 1-5、7）：清积分、清队列（采样器响应）、废擂台、EMA 重置、
      // R4 由流式引擎直写 T_settle_eff=80；转 STATIC 观察。
      this.integratorA = 0;
      this.gEma = 0;
      this.emaWarmupLeft = 3;
      this.settleStartPtsMs = null;
      this.mergeStartPtsMs = null;
      this.state = 'STATIC';
      this.enteredAtPtsMs = ptsMs;
      this.switchStaticSincePtsMs = ptsMs;
      this.fSwitchPending = true;
      effects.push('switch');
      return { state: this.state, effects };
    }

    switch (this.state) {
      case 'STATIC': {
        if (this.switchStaticSincePtsMs !== null) {
          // SWITCH 后静态观察窗（250ms）
          if (d > th.hHighEff) {
            this.switchStaticSincePtsMs = null;
            if (this.fSwitchPending) {
              this.fSwitchPending = false;
              effects.push('switch_motion_void');
            }
            this.toMotion(ptsMs, effects);
          } else if (ptsMs - this.switchStaticSincePtsMs >= th.switchStaticMs) {
            this.switchStaticSincePtsMs = null;
            if (this.fSwitchPending) {
              this.fSwitchPending = false;
              effects.push('switch_static_emit');
            }
          }
          // 合并窗在 SWITCH 场景不存在
          if (this.mergeStartPtsMs !== null) this.mergeStartPtsMs = null;
          return { state: this.state, effects };
        }
        // 常规 STATIC：防碎合并窗
        if (this.mergeStartPtsMs !== null && ptsMs - this.mergeStartPtsMs >= th.tMergeMs) {
          this.mergeStartPtsMs = null;
          effects.push('merge_emit');
        }
        if (d > th.hHighEff) {
          // 合并窗内运动复发：锁定的 F 留待与新 P 簇合并发出（mergeStart 清除）
          this.mergeStartPtsMs = null;
          this.toMotion(ptsMs, effects);
        }
        return { state: this.state, effects };
      }
      case 'MOTION': {
        if (d < hLow) {
          this.state = 'SETTLE';
          this.enteredAtPtsMs = ptsMs;
          this.settleStartPtsMs = ptsMs;
          effects.push('settle_enter');
        }
        return { state: this.state, effects };
      }
      case 'SETTLE': {
        if (d >= hLow) {
          this.state = 'MOTION';
          this.enteredAtPtsMs = ptsMs;
          this.settleStartPtsMs = null;
          effects.push('settle_cancel'); // 积分器 A 保持不清零
          return { state: this.state, effects };
        }
        const start = this.settleStartPtsMs ?? ptsMs;
        if (ptsMs - start >= th.tSettleEff) {
          // 锁定观察窗最清晰帧生成 F（采样器执行），清零积分器，转 STATIC + 合并窗
          this.integratorA = 0;
          this.settleStartPtsMs = null;
          this.state = 'STATIC';
          this.enteredAtPtsMs = ptsMs;
          this.mergeStartPtsMs = ptsMs;
          effects.push('settle_lock');
        }
        return { state: this.state, effects };
      }
      default:
        return { state: this.state, effects };
    }
  }

  private toMotion(ptsMs: number, effects: MachineEffect[]): void {
    this.state = 'MOTION';
    this.enteredAtPtsMs = ptsMs;
    this.emaWarmupLeft = 3; // EMA 3 帧预热
    effects.push('enter_motion');
  }
}

// ---------------------------------------------------------------------------
// PEAK 清晰度跟踪（规格《四》§2）——供流式引擎逐帧调用
// ---------------------------------------------------------------------------

export interface ClarityState {
  gEma: number;
  warmupLeft: number;
  rhoHistory: number[]; // 最近 3 个 ρ（含当前）
}

export function createClarityState(): ClarityState {
  return { gEma: 0, warmupLeft: 3, rhoHistory: [] };
}

/** 更新 EMA（1/8 系数）与 ρ；预热期内用当前帧梯度初始化/推进。 */
export function updateClarity(
  cs: ClarityState,
  g: number,
  opts: { resetWarmup?: boolean } = {},
): number {
  if (opts.resetWarmup) cs.warmupLeft = 3;
  if (cs.warmupLeft > 0) {
    // 预热：均值初始化并逐帧推进
    cs.gEma = cs.gEma === 0 ? g : g / 8 + (7 / 8) * cs.gEma;
    cs.warmupLeft -= 1;
  } else {
    cs.gEma = g / 8 + (7 / 8) * cs.gEma;
  }
  const rho = g / (cs.gEma + 1e-6);
  cs.rhoHistory.push(rho);
  if (cs.rhoHistory.length > 3) cs.rhoHistory.shift();
  return rho;
}

/**
 * PEAK 局部波峰判定：ρ_{t-1} ≥ ρ_{t-2} 且 ρ_{t-1} > ρ_t 且 ρ_{t-1} ≥ ρ_min。
 * 预热期（warmupLeft > 0 或历史不足 3 帧）不判波峰（返回 false）。
 */
export function isLocalPeak(cs: ClarityState, rhoMin: number): boolean {
  if (cs.rhoHistory.length < 3) return false;
  const [prev2, prev1, curr] = [cs.rhoHistory[0]!, cs.rhoHistory[1]!, cs.rhoHistory[2]!];
  return prev1 >= prev2 && prev1 > curr && prev1 >= rhoMin;
}

/** 擂台比较：候选是否击败当前记录（ρ 更高；无记录时恒真）。 */
export function beatsArena(candidate: { rho: number } | null, rho: number): boolean {
  return candidate === null || rho > candidate.rho;
}
