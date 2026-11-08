/**
 * Stage 2 施密特状态机单元测试（用例 8/9 的纯逻辑部分）：
 * 四态流转、SETTLE 防碎（T_settle + T_merge）、SWITCH 原子序列、
 * 黑场后静态观察 250ms、R4 相关状态、EMA 3 帧预热与局部波峰。
 */

import { describe, expect, it } from 'vitest';
import {
  SchmittMachine,
  beatsArena,
  createClarityState,
  updateClarity,
  type SchmittThresholds,
} from '../../../src/stage2/stateMachine.js';

const TH: SchmittThresholds = { hHighEff: 0.1, tSettleEff: 200, tMergeMs: 50, switchStaticMs: 250 };

describe('施密特流转', () => {
  it('STATIC 低 d 保持，d>hHigh 切 MOTION', () => {
    const m = new SchmittMachine();
    expect(m.step(0, 0.05, TH, 'none').state).toBe('STATIC');
    const s = m.step(100, 0.2, TH, 'none');
    expect(s.state).toBe('MOTION');
    expect(s.effects).toContain('enter_motion');
  });

  it('MOTION 低阈值保持（施密特滞回）', () => {
    const m = new SchmittMachine();
    m.step(0, 0.2, TH, 'none');
    expect(m.step(100, 0.06, TH, 'none').state).toBe('MOTION'); // d ≥ hLow=0.05 保持
    expect(m.step(200, 0.03, TH, 'none').state).toBe('SETTLE'); // d < hLow 进入停稳
  });

  it('SETTLE 满 T_settle 锁定 → STATIC → 满 T_merge 发出', () => {
    const m = new SchmittMachine();
    m.step(0, 0.2, TH, 'none');
    m.step(100, 0.03, TH, 'none'); // settle_enter @100
    const lock = m.step(350, 0.02, TH, 'none'); // 250ms ≥ 200ms
    expect(lock.state).toBe('STATIC');
    expect(lock.effects).toContain('settle_lock');
    expect(m.integratorA).toBe(0);
    const emit = m.step(420, 0.02, TH, 'none'); // 70ms ≥ 50ms
    expect(emit.effects).toContain('merge_emit');
  });

  it('SETTLE 未满期运动复发 → 退回 MOTION，积分器保留', () => {
    const m = new SchmittMachine();
    m.step(0, 0.2, TH, 'none');
    m.integratorA = 0.12; // 采样器侧积分
    m.step(100, 0.03, TH, 'none');
    const back = m.step(200, 0.2, TH, 'none');
    expect(back.state).toBe('MOTION');
    expect(back.effects).toContain('settle_cancel');
    expect(m.integratorA).toBeCloseTo(0.12); // 不清零
  });
});

describe('SWITCH 原子序列与静态观察', () => {
  it('原子效果：清积分、EMA 重置 3 帧、fSwitchPending、转 STATIC 观察', () => {
    const m = new SchmittMachine();
    m.step(0, 0.2, TH, 'none');
    m.integratorA = 0.2;
    const s = m.step(100, 0.9, TH, 'SWITCH');
    expect(s.effects).toEqual(['switch']);
    expect(s.state).toBe('STATIC');
    expect(m.integratorA).toBe(0);
    expect(m.emaWarmupLeft).toBe(3);
    expect(m.fSwitchPending).toBe(true);
    expect(m.switchStaticSincePtsMs).toBe(100);
  });

  it('SWITCH 后静止满 250ms → switch_static_emit', () => {
    const m = new SchmittMachine();
    m.step(0, 0.9, TH, 'SWITCH');
    const s = m.step(400, 0.01, TH, 'none'); // 300ms ≥ 250ms
    expect(s.effects).toContain('switch_static_emit');
    expect(m.fSwitchPending).toBe(false);
  });

  it('SWITCH 后 250ms 内运动 → 作废 F_switch 切 MOTION（R4 恢复路径①）', () => {
    const m = new SchmittMachine();
    m.step(0, 0.9, TH, 'SWITCH');
    const s = m.step(150, 0.5, TH, 'none');
    expect(s.effects).toContain('switch_motion_void');
    expect(s.effects).toContain('enter_motion');
    expect(m.fSwitchPending).toBe(false);
    expect(m.emaWarmupLeft).toBe(3); // toMotion 重置预热
  });
});

describe('EMA 预热与 PEAK 判定（用例 8）', () => {
  it('预热 3 帧：EMA 均值初始化后逐帧推进', () => {
    const cs = createClarityState();
    const r1 = updateClarity(cs, 0.4);
    expect(cs.gEma).toBeCloseTo(0.4);
    expect(r1).toBeCloseTo(1);
    expect(cs.warmupLeft).toBe(2);
    updateClarity(cs, 0.4);
    updateClarity(cs, 0.4);
    expect(cs.warmupLeft).toBe(0); // 3 帧预热结束
    const r4 = updateClarity(cs, 0.8); // 第 4 帧
    expect(cs.gEma).toBeCloseTo(0.8 / 8 + (7 / 8) * 0.4);
    expect(r4).toBeGreaterThan(1.7);
  });

  it('resetWarmup 后重新进入预热', () => {
    const cs = createClarityState();
    updateClarity(cs, 0.4);
    updateClarity(cs, 0.4);
    updateClarity(cs, 0.4);
    updateClarity(cs, 0.4, { resetWarmup: true });
    expect(cs.warmupLeft).toBe(2);
  });

  it('擂台：无记录恒真，严格更优才击败', () => {
    expect(beatsArena(null, 0.01)).toBe(true);
    expect(beatsArena({ rho: 1.2 }, 1.1)).toBe(false);
    expect(beatsArena({ rho: 1.2 }, 1.3)).toBe(true);
    expect(beatsArena({ rho: 1.2 }, 1.2)).toBe(false); // 严格大于
  });
});
