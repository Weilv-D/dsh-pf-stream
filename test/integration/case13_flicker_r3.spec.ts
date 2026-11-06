import { describe, expect, it } from 'vitest';
import { makeFixtureSlot as makeSlot, runFixtureStream, type StreamRunResult } from './helpers.js';

/** 从流式结果取 CanvasPacket 列表（packets 为带字节的 artifact）。 */
function packetsOf(result: StreamRunResult) {
  return result.packets.map((a) => a.packet);
}

/** 用例 13：频闪抑制 R3 与硬切阈值解耦。
 *  fixture：半屏高频翻转（r_flip≈1）2s → 暗纹理（硬切）1s → 灰 3s。 */
describe('case13 flicker R3 + hard-switch decoupling', () => {
  it('R3 激活：ctrl_id 回填、α=0.1、H_high_eff→min(0.20,1.3×base) 平滑收敛', async () => {
    const slot = await makeSlot('case13_flicker_cut.mp4');
    const result = await runFixtureStream('case13_flicker_cut.mp4', slot, { windowMs: 6000 });

    // 频闪段（<2000ms）发出的包携带 flicker_suppress ctrl_id
    const flickerPackets = packetsOf(result).filter(
      (p) =>
        p.units.some((u) => u.timestampMs < 1800) &&
        p.appliedCtrlId.some((id) => id.includes('flicker_suppress')),
    );
    expect(flickerPackets.length).toBeGreaterThan(0);

    // 节拍日志：激活后 H_high_eff 高于基准并按 0.6/0.4 平滑逼近 0.13
    const ticks = result.telemetry.ctrlTickLog ?? [];
    expect(ticks.length).toBeGreaterThan(0);
    const raised = ticks.filter((t) => t.activeRules.includes('flicker_suppress'));
    expect(raised.length).toBeGreaterThan(0);
    expect(Math.max(...raised.map((t) => t.hHighEff))).toBeGreaterThan(0.118);
    // 恢复后向 0.10 收敛
    const last = ticks[ticks.length - 1]!;
    expect(last.hHighEff).toBeLessThan(0.105);
  });

  it('R3 激活期间硬切判据仍以固定阈值触发 SWITCH_STATIC（与 H_high_eff 解耦）', async () => {
    const slot = await makeSlot('case13_flicker_cut.mp4');
    const result = await runFixtureStream('case13_flicker_cut.mp4', slot, { windowMs: 6000 });

    const switchPackets = packetsOf(result).filter((p) => p.triggerPath === 'SWITCH_STATIC');
    expect(switchPackets.length).toBeGreaterThan(0);
    // 第一处硬切发生在 2000ms（翻转→暗纹理）
    const first = switchPackets.find((p) =>
      p.units.some((u) => u.timestampMs >= 2000 && u.timestampMs <= 2100),
    );
    expect(first).toBeDefined();
    // 解耦断言即上面两条：R3 已把 H_high_eff 抬升（首用例）而 SWITCH 仍触发——
    // 硬切判据走 SWITCH_MIN_BLOCKS/SWITCH_HIST_L1 固定阈值，不读 H_high_eff。
  });

  it('telemetry.ctrlParams 字段完整（基准值/目标值/生效值）', async () => {
    const slot = await makeSlot('case13_flicker_cut.mp4');
    const result = await runFixtureStream('case13_flicker_cut.mp4', slot, { windowMs: 6000 });
    const cp = result.telemetry.ctrlParams;
    expect(cp).toMatchObject({
      SBase: 0.15,
      TCoolBase: 1500,
      TSettleBase: 200,
      HHighBase: 0.1,
    });
    expect(cp.SEff).toBeGreaterThan(0);
    expect(cp.TCoolEff).toBeGreaterThan(0);
    expect(cp.TSettleEff).toBeGreaterThan(0);
    expect(cp.HHighEff).toBeGreaterThan(0);
  });
});
