import { describe, expect, it } from 'vitest';
import { StreamController } from '../../../src/stage5/controller.js';
import type { StreamBaselines } from '../../../src/stage5/intent.js';

const STEP = 1000 / 30;

function baselines(): StreamBaselines {
  return {
    SBase: 0.15,
    SEff: 0.15,
    TCoolBase: 1500,
    TCoolEff: 1500,
    TSettleBase: 200,
    TSettleEff: 200,
    HHighBase: 0.1,
    HHighEff: 0.1,
    TMaxMEff: 1500,
    RhoMinEff: 1.05,
  };
}

/** 按等效 30fps 步长给控制器喂帧信号（fromPts = 已喂帧数 × STEP）。 */
function feed(
  ctrl: StreamController,
  count: number,
  opts: { fromFrame?: number; d?: number; rFlip?: number; state?: string } = {},
): void {
  const from = (opts.fromFrame ?? 0) * STEP;
  for (let i = 0; i < count; i += 1) {
    const pts = Math.round(from + (i + 1) * STEP);
    ctrl.onFrameStepped(pts, opts.d ?? 0, opts.rFlip ?? 0, opts.state ?? 'MOTION');
  }
}

describe('StreamController R3 频闪抑制', () => {
  it('r_flip>0.6 连续超过 5 帧激活：目标 min(0.20,1.3×base)，一阶平滑 0.6/0.4', () => {
    const ctrl = new StreamController(baselines());
    feed(ctrl, 20, { d: 1, rFlip: 1 });
    expect(ctrl.activeSlugs()).toContain('flicker_suppress');
    expect(ctrl.live.HHighEff).toBeCloseTo(0.6 * 0.13 + 0.4 * 0.1, 6);
    expect(ctrl.alphaFor(1)).toBe(0.1);
  });

  it('r_flip≤0.6 持续满 10 帧恢复：目标回基准并按平滑收敛', () => {
    const ctrl = new StreamController(baselines());
    feed(ctrl, 20, { d: 1, rFlip: 1 });
    feed(ctrl, 11, { fromFrame: 20, d: 1, rFlip: 0.3 });
    expect(ctrl.activeSlugs()).not.toContain('flicker_suppress');
    expect(ctrl.alphaFor(1)).toBe(1);
    // 恢复 tick 平滑一次：0.6×0.10 + 0.4×0.118 = 0.1072
    expect(ctrl.live.HHighEff).toBeLessThan(0.11);
  });

  it('R3 激活期间冻结 R1/R2 的新触发', () => {
    const ctrl = new StreamController(baselines());
    // 同时满足 R1（慢）与 R3（频闪）条件
    feed(ctrl, 20, { d: 0.11, rFlip: 1 });
    expect(ctrl.activeSlugs()).toEqual(['flicker_suppress']);
    // R1 的 condSince 被 R3 清除：频闪恢复后 R1 需重新累计 500ms
    feed(ctrl, 11, { fromFrame: 20, d: 0.11, rFlip: 0.3 });
    expect(ctrl.activeSlugs()).not.toContain('slow_sparsify');
    feed(ctrl, 20, { fromFrame: 31, d: 0.11, rFlip: 0.3 });
    expect(ctrl.activeSlugs()).toContain('slow_sparsify');
  });
});

describe('StreamController R1 慢速运动稀疏化', () => {
  it('均值 < 1.2×H_high 持续 ≥500ms 触发：S_target=min(0.30,1.5×S_base)，逐节拍平滑', () => {
    const ctrl = new StreamController(baselines());
    feed(ctrl, 56, { d: 0.11 });
    const active = ctrl.tickLog.filter((t) => t.activeRules.includes('slow_sparsify'));
    expect(active.length).toBeGreaterThanOrEqual(2);
    // 激活首拍：0.6×0.225 + 0.4×0.15 = 0.195（规格 telemetry 示例值）
    expect(active[0]!.sEff).toBeCloseTo(0.195, 6);
    expect(active[1]!.sEff).toBeCloseTo(0.6 * 0.225 + 0.4 * 0.195, 6);
    // 向 0.225 单调收敛
    expect(active[active.length - 1]!.sEff).toBeGreaterThan(0.21);
  });

  it('均值回升 ≥ 1.2×H_high 或退出 MOTION 恢复 S_target=base', () => {
    const ctrl = new StreamController(baselines());
    feed(ctrl, 32, { d: 0.11 });
    expect(ctrl.activeSlugs()).toContain('slow_sparsify');
    feed(ctrl, 32, { fromFrame: 32, d: 0.3 }); // 均值回升至 1.2×~3.0× 之间
    expect(ctrl.activeSlugs()).not.toContain('slow_sparsify');
    expect(ctrl.live.SEff).toBeLessThan(0.19); // 向 0.15 收敛

    const ctrl2 = new StreamController(baselines());
    feed(ctrl2, 32, { d: 0.11 });
    feed(ctrl2, 6, { fromFrame: 32, d: 0.11, state: 'SETTLE' }); // 退出 MOTION
    expect(ctrl2.activeSlugs()).not.toContain('slow_sparsify');
  });
});

describe('StreamController R2 快速运镜冷却延长', () => {
  it('均值 > 3.0×H_high 持续 ≥500ms 触发：T_cool_target=min(3000,1.8×base)', () => {
    const ctrl = new StreamController(baselines());
    feed(ctrl, 64, { d: 0.8 });
    const active = ctrl.tickLog.filter((t) => t.activeRules.includes('rapid_cool_extend'));
    expect(active.length).toBeGreaterThanOrEqual(3);
    // 激活首拍：0.6×2700 + 0.4×1500 = 2220
    expect(active[0]!.tCoolEff).toBeCloseTo(2220, 6);
    expect(active[1]!.tCoolEff).toBeCloseTo(0.6 * 2700 + 0.4 * 2220, 6);
    // 向 2700 单调收敛
    expect(active[active.length - 1]!.tCoolEff).toBeGreaterThan(2600);
  });

  it('均值回落或进入 SETTLE/STATIC 恢复 T_cool_target=base', () => {
    const ctrl = new StreamController(baselines());
    feed(ctrl, 32, { d: 0.8 });
    expect(ctrl.activeSlugs()).toContain('rapid_cool_extend');
    feed(ctrl, 32, { fromFrame: 32, d: 0.2 }); // 0.2 介于 1.2× 与 3.0× 之间
    expect(ctrl.activeSlugs()).not.toContain('rapid_cool_extend');
    expect(ctrl.live.TCoolEff).toBeLessThan(2000);
  });
});

describe('StreamController R4 硬切快速定格', () => {
  it('onSwitch 零延迟直写 T_settle=80', () => {
    const ctrl = new StreamController(baselines());
    ctrl.onSwitch(1000);
    expect(ctrl.live.TSettleEff).toBe(80);
    expect(ctrl.activeCtrlIds().some((id) => id.includes('switch_fast_settle'))).toBe(true);
  });

  it('双恢复路径：SWITCH 后进入 MOTION 立即恢复；STATIC 稳定满 T_settle_base 恢复', () => {
    const c1 = new StreamController(baselines());
    c1.onSwitch(1000);
    c1.onFrameStepped(1033, 0.5, 0, 'MOTION'); // 路径①
    expect(c1.live.TSettleEff).toBe(200);

    const c2 = new StreamController(baselines());
    c2.onSwitch(1000);
    c2.onFrameStepped(1033, 0, 0, 'STATIC');
    expect(c2.live.TSettleEff).toBe(80); // 距切换仅 33ms，不得恢复
    c2.onFrameStepped(1233, 0, 0, 'STATIC'); // 路径②：满 200ms
    expect(c2.live.TSettleEff).toBe(200);
  });

  it('回归：切换前静止 ≥T_settle_base 也不在切换帧当场恢复（计时起点对齐切换时刻）', () => {
    const c = new StreamController(baselines());
    // 预切静止 500ms（> T_settle_base=200）：旧实现的 stateSincePtsMs 停留在 0，
    // 切换帧 ptsMs-0 ≥ 200 → 当场恢复，快定格失效
    c.onFrameStepped(0, 0, 0, 'STATIC');
    c.onFrameStepped(500, 0, 0, 'STATIC');
    c.onSwitch(533);
    expect(c.live.TSettleEff).toBe(80);
    c.onFrameStepped(566, 0, 0, 'STATIC'); // 距切换 33ms
    expect(c.live.TSettleEff).toBe(80);
    c.onFrameStepped(766, 0, 0, 'STATIC'); // 距切换 233ms ≥ 200ms
    expect(c.live.TSettleEff).toBe(200);
  });

  it('切换前 MOTION → SWITCH：迁移分支照常退场 R1/R2 并重置计时', () => {
    const c = new StreamController(baselines());
    feed(c, 32, { d: 0.11 }); // R1 激活（MOTION 慢速）
    expect(c.activeSlugs()).toContain('slow_sparsify');
    c.onSwitch(1100); // 切换前 lastState='MOTION'
    c.onFrameStepped(1133, 0, 0, 'STATIC'); // 迁移分支：退场 R1 + 计时重置
    expect(c.activeSlugs()).not.toContain('slow_sparsify');
    expect(c.live.TSettleEff).toBe(80); // R4 仍生效（距切换 33ms）
    c.onFrameStepped(1366, 0, 0, 'STATIC'); // 距切换 233ms
    expect(c.live.TSettleEff).toBe(200);
  });
});

describe('StreamController 节拍与快照', () => {
  it('500ms PTS 节拍：相邻 tickLog 间隔 ≥500ms，首个调用只设锚', () => {
    const ctrl = new StreamController(baselines());
    feed(ctrl, 30, { d: 0.5 });
    const ptsList = ctrl.tickLog.map((t) => t.ptsMs);
    expect(ptsList.length).toBeGreaterThan(1);
    for (let i = 1; i < ptsList.length; i += 1) {
      expect(ptsList[i]! - ptsList[i - 1]!).toBeGreaterThanOrEqual(500);
    }
  });

  it('snapshot/restore 往返保持全部生效值与规则状态', () => {
    const ctrl = new StreamController(baselines());
    feed(ctrl, 32, { d: 0.11 });
    const restored = new StreamController(baselines(), 0, ctrl.snapshot());
    expect(restored.live).toEqual(ctrl.live);
    expect(restored.activeSlugs()).toEqual(ctrl.activeSlugs());
    // 续喂后两者在同一节拍推进并收敛到同一生效值（tickLog 属遥测，不进快照）
    feed(ctrl, 40, { fromFrame: 32, d: 0.11 });
    feed(restored, 40, { fromFrame: 32, d: 0.11 });
    expect(restored.tickLog.length).toBeGreaterThan(0);
    expect(restored.tickLog.length).toEqual(ctrl.tickLog.length - 3);
    expect(restored.live.SEff).toBeCloseTo(ctrl.live.SEff, 9);
    expect(restored.live.HHighEff).toBeCloseTo(ctrl.live.HHighEff, 9);
  });
});
