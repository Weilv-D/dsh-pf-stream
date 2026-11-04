import { describe, expect, it } from 'vitest';
import { makeFixtureSlot as makeSlot, runFixtureStream, type StreamRunResult } from './helpers.js';

/** 从流式结果取 CanvasPacket 列表（packets 为带字节的 artifact）。 */
function packetsOf(result: StreamRunResult) {
  return result.packets.map((a) => a.packet);
}

/** 用例 14：慢速稀疏 R1 与快速冷却 R2 的 500ms PTS 节拍平滑。
 *  fixture：case14_slow（慢速调制带）与 case14_fast（随机格带平移）各带静止尾。 */
describe('case14 R1 slow sparsify + R2 rapid cool extend', () => {
  it('R1：500ms 均值 < 1.2×H_high 触发，S_target=min(0.30,1.5×S_base)，逐节拍平滑', async () => {
    const slot = await makeSlot('case14_slow.mp4');
    const result = await runFixtureStream('case14_slow.mp4', slot, { windowMs: 5500 });

    const ticks = result.telemetry.ctrlTickLog ?? [];
    const active = ticks.filter((t) => t.activeRules.includes('slow_sparsify'));
    expect(active.length).toBeGreaterThanOrEqual(2);

    // 激活首拍：0.6×0.225 + 0.4×0.15 = 0.195（规格 telemetry 示例值）
    expect(active[0]!.sEff).toBeCloseTo(0.195, 2);
    expect(active[1]!.sEff).toBeCloseTo(0.6 * 0.225 + 0.4 * 0.195, 2);
    // 向 0.225 单调收敛
    expect(active[active.length - 1]!.sEff).toBeGreaterThan(0.21);

    // 包回填 ctrl_id
    expect(
      packetsOf(result).some((p) => p.appliedCtrlId.some((id) => id.includes('slow_sparsify'))),
    ).toBe(true);
  });

  it('R1 恢复：静止尾退出 MOTION 后 S 向基准回落', async () => {
    const slot = await makeSlot('case14_slow.mp4');
    const result = await runFixtureStream('case14_slow.mp4', slot, { windowMs: 5500 });
    const ticks = result.telemetry.ctrlTickLog ?? [];
    const last = ticks[ticks.length - 1]!;
    expect(last.activeRules).not.toContain('slow_sparsify');
    expect(last.sEff).toBeLessThan(0.19); // 0.15…0.18 收敛段
  });

  it('R2：500ms 均值 > 3.0×H_high 触发，T_cool_target=min(3000,1.8×base)，逐节拍平滑', async () => {
    const slot = await makeSlot('case14_fast.mp4');
    const result = await runFixtureStream('case14_fast.mp4', slot, { windowMs: 5500 });

    const ticks = result.telemetry.ctrlTickLog ?? [];
    const active = ticks.filter((t) => t.activeRules.includes('rapid_cool_extend'));
    expect(active.length).toBeGreaterThanOrEqual(2);
    // 激活首拍：0.6×2700 + 0.4×1500 = 2220
    expect(active[0]!.tCoolEff).toBeCloseTo(2220, -1);
    // 向 2700 单调收敛
    expect(active[active.length - 1]!.tCoolEff).toBeGreaterThan(2600);
    // 包回填 ctrl_id
    expect(
      packetsOf(result).some((p) => p.appliedCtrlId.some((id) => id.includes('rapid_cool_extend'))),
    ).toBe(true);
  });

  it('R2 恢复：静止尾退出 MOTION 后 T_cool 向基准回落；全程无 SWITCH 包', async () => {
    const slot = await makeSlot('case14_fast.mp4');
    const result = await runFixtureStream('case14_fast.mp4', slot, { windowMs: 5500 });
    const ticks = result.telemetry.ctrlTickLog ?? [];
    const last = ticks[ticks.length - 1]!;
    expect(last.activeRules).not.toContain('rapid_cool_extend');
    expect(last.tCoolEff).toBeLessThan(2000);
    // 随机格带直方图时不变：判 WHIP 保持 MOTION，无硬切
    expect(packetsOf(result).some((p) => p.triggerPath === 'SWITCH_STATIC')).toBe(false);
    expect(packetsOf(result).some((p) => p.units.some((u) => u.scale === '1x1_P'))).toBe(true);
  });

  it('500ms 节拍以 PTS 域推进：相邻 tickLog 间隔 ≥500ms', async () => {
    const slot = await makeSlot('case14_fast.mp4');
    const result = await runFixtureStream('case14_fast.mp4', slot, { windowMs: 5500 });
    const ptsList = (result.telemetry.ctrlTickLog ?? []).map((t) => t.ptsMs);
    expect(ptsList.length).toBeGreaterThan(2);
    for (let i = 1; i < ptsList.length; i += 1) {
      expect(ptsList[i]! - ptsList[i - 1]!).toBeGreaterThanOrEqual(500);
    }
  });
});
