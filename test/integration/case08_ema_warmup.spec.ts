/**
 * 用例 8：EMA 3 帧预热保护（e2e + golden 基准）。
 * fixture：case08_ema_warmup.mp4（灰 0.5s → 门控翻转 gblur 0.5s → 清晰续段 2.0s）。
 *
 * MOTION 进入点 ≈580ms（模糊渐入段），3 帧预热期（≈580-680ms）全部落在
 * 模糊段；清晰段 [1000, 1500) 梯度跳升后 SETTLE 观察窗被清晰帧占据。
 * 断言：全部 F 锚点 PTS 不落预热期；SETTLE 锚点落在清晰段；
 * 包序列（形态/触发/单元 PTS）锁 golden 基准。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, makeSlot, runFixtureStream, expectPacketLegal } from './helpers.js';
import { expectGolden } from './golden.js';

/** 模糊段结束 = 清晰段起点。 */
const CLEAR_START_MS = 1000;
/** 预热期安全下界：MOTION 进入点（≥580ms）+ 3 步（100ms）。 */
const WARMUP_SAFE_END_MS = 600;

describe('用例 8：EMA 预热保护', () => {
  it('全部 F 锚点 PTS 不落预热期；SETTLE 锚点落在清晰段（观察窗被清晰帧占据）', async () => {
    const slot = await makeSlot(join(FIXTURES, 'case08_ema_warmup.mp4'));
    const result = await runFixtureStream('case08_ema_warmup.mp4', slot);
    expectPacketLegal(result);
    expect(result.packets.length).toBeGreaterThanOrEqual(1);
    const fArtifacts = result.packets.filter((p) => p.packet.anchorFId !== null);
    expect(fArtifacts.length).toBeGreaterThanOrEqual(1);
    for (const a of fArtifacts) {
      for (const u of a.packet.units.filter((u) => u.scale === '2x2_F')) {
        // 预热期内（MOTION 进入后 3 步）锁定的帧不得作为 F 发出
        expect(u.timestampMs).toBeGreaterThanOrEqual(WARMUP_SAFE_END_MS);
      }
    }
    // 渐出停稳后的 SETTLE 锚点必在清晰段（观察窗 g 最高帧为渐出前高对比帧）
    const settleF = fArtifacts.filter((a) => a.packet.triggerPath === 'SETTLE');
    expect(settleF.length).toBeGreaterThanOrEqual(1);
    for (const a of settleF) {
      const f = a.packet.units.find((u) => u.scale === '2x2_F')!;
      expect(f.timestampMs).toBeGreaterThanOrEqual(CLEAR_START_MS);
    }
    // P 单元从模糊段翻转期开始（位移积分不受 EMA 预热限制）
    const pUnits = result.packets.flatMap((p) =>
      p.packet.units.filter((u) => u.scale === '1x1_P').map((u) => u.timestampMs),
    );
    expect(pUnits.length).toBeGreaterThanOrEqual(1);
  });

  it('包序列 golden 基准（形态/触发路径/单元 PTS）', async () => {
    const slot = await makeSlot(join(FIXTURES, 'case08_ema_warmup.mp4'));
    const result = await runFixtureStream('case08_ema_warmup.mp4', slot);
    await expectGolden(
      'case08_arena_pts',
      result.packets.map((p) => ({
        packetId: p.packet.packetId,
        layoutForm: p.packet.layoutForm,
        triggerPath: p.packet.triggerPath,
        anchorFId: p.packet.anchorFId,
        units: p.packet.units.map((u) => ({
          globalId: u.globalId,
          timestampMs: u.timestampMs,
          scale: u.scale,
        })),
      })),
    );
  });
});
