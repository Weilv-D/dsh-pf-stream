/**
 * Stage 5（内容自闭环层）—— R1-R4 规则与 500ms PTS 节拍平滑（规格《五》§2）。
 *
 * 优先级 R3 > R1 > R2 > R4：R3 频闪抑制激活期间冻结 R1/R2 的新触发；
 * R1/R2/R3 以 ΔPTS ≥ 500ms 为更新节拍，执行一阶平滑 θ_new = clamp(0.6·target + 0.4·curr)；
 * R4 在 SWITCH 触发时刻零延迟直写 T_settle_eff = 80ms，恢复走双路径
 * （① 首个 MOTION；② STATIC 稳定满 T_settle_base），独立于节拍。
 *
 * 生效值写入 live（StreamBaselines 可变引用），streamSampler 每步直接读取；
 * 基准值 base 保持不变，供遥测与恢复使用。
 */

import { clamp, H_HIGH_RANGE, S_RANGE, T_COOL_RANGE, T_SETTLE_RANGE, type StreamBaselines } from './intent.js';
import type { ControllerSnapshot, CtrlTickLogEntry } from '../types.js';

export const CTRL_TICK_MS = 500;
export const R3_FLIP_TRIGGER_FRAMES = 5; // r_flip>0.6 连续超过 5 帧
export const R3_FLIP_RECOVER_FRAMES = 10; // r_flip≤0.6 持续满 10 帧
export const R4_SETTLE_MS = 80;
const TICK_LOG_LIMIT = 96;
const D_HIST_WINDOW_MS = 500;
const D_HIST_MIN_SAMPLES = 3;

type RuleKey = 'r1' | 'r2' | 'r3' | 'r4';

const RULE_SLUGS: Record<RuleKey, string> = {
  r1: 'slow_sparsify',
  r2: 'rapid_cool_extend',
  r3: 'flicker_suppress',
  r4: 'switch_fast_settle',
};

export class StreamController {
  /** 当前生效参数（原地变更，采样器直接读取）。 */
  readonly live: StreamBaselines;
  private readonly base: StreamBaselines;

  private r1Active = false;
  private r2Active = false;
  private r3Active = false;
  private r4Active = false;
  private sTarget: number;
  private tCoolTarget: number;
  private hHighTarget: number;
  private readonly ctrlId: Partial<Record<RuleKey, string>> = {};
  private readonly seq: Record<RuleKey, number> = { r1: 0, r2: 0, r3: 0, r4: 0 };

  private lastTickPtsMs: number | null = null;
  private readonly dHist: Array<{ ptsMs: number; d: number }> = [];
  private rFlipRun = 0;
  private rFlipCalmRun = 0;
  private r1CondSincePtsMs: number | null = null;
  private r2CondSincePtsMs: number | null = null;

  private lastState: 'STATIC' | 'MOTION' | 'SETTLE' | 'SWITCH' = 'STATIC';
  private stateSincePtsMs: number;

  /** 每 500ms 节拍的生效值轨迹（遥测断言用）。 */
  readonly tickLog: CtrlTickLogEntry[] = [];

  constructor(baselines: StreamBaselines, initialPtsMs = 0, snapshot?: ControllerSnapshot) {
    this.base = baselines;
    this.live = { ...baselines };
    this.sTarget = baselines.SBase;
    this.tCoolTarget = baselines.TCoolBase;
    this.hHighTarget = baselines.HHighBase;
    this.stateSincePtsMs = initialPtsMs;
    if (snapshot) this.restore(snapshot);
  }

  /** SWITCH 效果：R4 零延迟直写（规格《三》§3 原子步骤 5）。 */
  onSwitch(ptsMs: number): void {
    this.r4Active = true;
    this.live.TSettleEff = clamp(R4_SETTLE_MS, T_SETTLE_RANGE);
    this.ctrlId.r4 = this.nextId('r4', ptsMs);
  }

  /**
   * 每个步进帧调用：r_flip 连续计数、状态迁移（R4 恢复路径与 R1/R2 退场）、
   * 500ms 节拍上的 R3→R1→R2 求值与一阶平滑。
   */
  onFrameStepped(
    ptsMs: number,
    d: number,
    rFlip: number,
    machineState: 'STATIC' | 'MOTION' | 'SETTLE' | 'SWITCH',
  ): void {
    // r_flip 连续计数（R3 触发/恢复帧计数以对齐后的有效感知步为单位）
    if (rFlip > 0.6) {
      this.rFlipRun++;
      this.rFlipCalmRun = 0;
    } else {
      this.rFlipCalmRun++;
      this.rFlipRun = 0;
    }

    // 状态迁移
    if (machineState !== this.lastState) {
      if (this.lastState !== 'MOTION' && machineState === 'MOTION') {
        this.recoverR4(ptsMs); // R4 恢复路径①
      }
      if (this.lastState === 'MOTION' && machineState !== 'MOTION') {
        this.deactivateR1(); // 规格 R1/R2 恢复：退出 MOTION → 目标回基准
        this.deactivateR2();
      }
      this.lastState = machineState;
      this.stateSincePtsMs = ptsMs;
    } else if (this.r4Active && machineState === 'STATIC' && ptsMs - this.stateSincePtsMs >= this.base.TSettleBase) {
      this.recoverR4(ptsMs); // R4 恢复路径②：SWITCH 后 STATIC 稳定满 T_settle_base
    }

    // 滑动均值样本
    this.dHist.push({ ptsMs, d });
    while (this.dHist.length > 0 && ptsMs - this.dHist[0]!.ptsMs > D_HIST_WINDOW_MS) this.dHist.shift();

    // 500ms PTS 节拍
    if (this.lastTickPtsMs !== null && ptsMs - this.lastTickPtsMs < CTRL_TICK_MS) return;
    this.lastTickPtsMs = ptsMs;
    const mean =
      this.dHist.length >= D_HIST_MIN_SAMPLES
        ? this.dHist.reduce((acc, s) => acc + s.d, 0) / this.dHist.length
        : null;

    // R3：优先级最高，最先求值；激活期间冻结 R1/R2 新触发
    if (!this.r3Active) {
      if (this.rFlipRun > R3_FLIP_TRIGGER_FRAMES) {
        this.r3Active = true;
        this.hHighTarget = Math.min(H_HIGH_RANGE[1], 1.3 * this.base.HHighBase);
        this.ctrlId.r3 = this.nextId('r3', ptsMs);
        this.r1CondSincePtsMs = null;
        this.r2CondSincePtsMs = null;
      }
    } else if (this.rFlipCalmRun >= R3_FLIP_RECOVER_FRAMES) {
      this.r3Active = false;
      delete this.ctrlId.r3;
      this.hHighTarget = this.base.HHighBase;
    }

    if (!this.r3Active && mean !== null) {
      // R1：慢速运动稀疏化
      const r1Cond = machineState === 'MOTION' && mean < 1.2 * this.live.HHighEff;
      if (r1Cond) {
        this.r1CondSincePtsMs ??= ptsMs;
        if (!this.r1Active && ptsMs - this.r1CondSincePtsMs >= CTRL_TICK_MS) {
          this.r1Active = true;
          this.sTarget = Math.min(S_RANGE[1], 1.5 * this.base.SBase);
          this.ctrlId.r1 = this.nextId('r1', ptsMs);
        }
      } else {
        this.r1CondSincePtsMs = null;
        if (this.r1Active && mean >= 1.2 * this.live.HHighEff) this.deactivateR1();
      }

      // R2：快速运镜冷却延长
      const r2Cond = machineState === 'MOTION' && mean > 3.0 * this.live.HHighEff;
      if (r2Cond) {
        this.r2CondSincePtsMs ??= ptsMs;
        if (!this.r2Active && ptsMs - this.r2CondSincePtsMs >= CTRL_TICK_MS) {
          this.r2Active = true;
          this.tCoolTarget = Math.min(T_COOL_RANGE[1], 1.8 * this.base.TCoolBase);
          this.ctrlId.r2 = this.nextId('r2', ptsMs);
        }
      } else {
        this.r2CondSincePtsMs = null;
        if (this.r2Active && mean <= 3.0 * this.live.HHighEff) this.deactivateR2();
      }
    }

    // 一阶平滑（θ_new = clamp(0.6·target + 0.4·curr)）
    this.live.SEff = clamp(0.6 * this.sTarget + 0.4 * this.live.SEff, S_RANGE);
    this.live.TCoolEff = clamp(0.6 * this.tCoolTarget + 0.4 * this.live.TCoolEff, T_COOL_RANGE);
    this.live.HHighEff = clamp(0.6 * this.hHighTarget + 0.4 * this.live.HHighEff, H_HIGH_RANGE);

    this.tickLog.push({
      ptsMs,
      sEff: this.live.SEff,
      tCoolEff: this.live.TCoolEff,
      tSettleEff: this.live.TSettleEff,
      hHighEff: this.live.HHighEff,
      activeRules: this.activeSlugs(),
    });
    if (this.tickLog.length > TICK_LOG_LIMIT) this.tickLog.shift();
  }

  /** R3 激活期间 α 锁定 0.1（规格 R3 调节动作）。 */
  alphaFor(signalAlpha: number): number {
    return this.r3Active ? 0.1 : signalAlpha;
  }

  /** 当前激活规则的 ctrl_id 列表（发包回填 applied_ctrl_id）。 */
  activeCtrlIds(): string[] {
    return (['r1', 'r2', 'r3', 'r4'] as RuleKey[])
      .map((k) => (this.isActive(k) ? this.ctrlId[k] : undefined))
      .filter((v): v is string => v !== undefined);
  }

  activeSlugs(): string[] {
    return (['r1', 'r2', 'r3', 'r4'] as RuleKey[]).filter((k) => this.isActive(k)).map((k) => RULE_SLUGS[k]);
  }

  snapshot(): ControllerSnapshot {
    return {
      sTarget: this.sTarget,
      tCoolTarget: this.tCoolTarget,
      hHighTarget: this.hHighTarget,
      r1Active: this.r1Active,
      r2Active: this.r2Active,
      r3Active: this.r3Active,
      r4Active: this.r4Active,
      ctrlId: { ...this.ctrlId },
      seq: { ...this.seq },
      lastTickPtsMs: this.lastTickPtsMs,
      rFlipRun: this.rFlipRun,
      rFlipCalmRun: this.rFlipCalmRun,
      r1CondSincePtsMs: this.r1CondSincePtsMs,
      r2CondSincePtsMs: this.r2CondSincePtsMs,
      lastState: this.lastState,
      stateSincePtsMs: this.stateSincePtsMs,
      liveSEff: this.live.SEff,
      liveTCoolEff: this.live.TCoolEff,
      liveTSettleEff: this.live.TSettleEff,
      liveHHighEff: this.live.HHighEff,
    };
  }

  private restore(s: ControllerSnapshot): void {
    this.sTarget = s.sTarget;
    this.tCoolTarget = s.tCoolTarget;
    this.hHighTarget = s.hHighTarget;
    this.r1Active = s.r1Active;
    this.r2Active = s.r2Active;
    this.r3Active = s.r3Active;
    this.r4Active = s.r4Active;
    Object.assign(this.ctrlId, s.ctrlId);
    Object.assign(this.seq, s.seq);
    this.lastTickPtsMs = s.lastTickPtsMs;
    this.rFlipRun = s.rFlipRun;
    this.rFlipCalmRun = s.rFlipCalmRun;
    this.r1CondSincePtsMs = s.r1CondSincePtsMs;
    this.r2CondSincePtsMs = s.r2CondSincePtsMs;
    this.lastState = s.lastState;
    this.stateSincePtsMs = s.stateSincePtsMs;
    this.live.SEff = s.liveSEff;
    this.live.TCoolEff = s.liveTCoolEff;
    this.live.TSettleEff = s.liveTSettleEff;
    this.live.HHighEff = s.liveHHighEff;
  }

  private isActive(k: RuleKey): boolean {
    switch (k) {
      case 'r1':
        return this.r1Active;
      case 'r2':
        return this.r2Active;
      case 'r3':
        return this.r3Active;
      case 'r4':
        return this.r4Active;
    }
  }

  private deactivateR1(): void {
    this.r1Active = false;
    delete this.ctrlId.r1;
    this.sTarget = this.base.SBase;
    this.r1CondSincePtsMs = null;
  }

  private deactivateR2(): void {
    this.r2Active = false;
    delete this.ctrlId.r2;
    this.tCoolTarget = this.base.TCoolBase;
    this.r2CondSincePtsMs = null;
  }

  private recoverR4(_ptsMs: number): void {
    this.r4Active = false;
    delete this.ctrlId.r4;
    this.live.TSettleEff = clamp(this.base.TSettleBase, T_SETTLE_RANGE);
  }

  private nextId(k: RuleKey, _ptsMs: number): string {
    this.seq[k]++;
    return `ctrl_${RULE_SLUGS[k]}_${String(this.seq[k]).padStart(3, '0')}`;
  }
}
