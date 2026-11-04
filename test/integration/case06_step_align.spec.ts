/**
 * 用例 6：等效 30fps 步长对齐与局部梯度归一化。
 * fixture：case06a_fps24.mp4 / case06b_fps60.mp4（同 48px/s 运动）、case06c_dark.mp4（低对比度）。
 * 期望：24fps 与 60fps 同速运动产出 P 数一致（±1）；暗光低对比度大幅运动仍产出 P。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, makeSlot, runFixtureStream, expectPacketLegal } from './helpers.js';
import type { StreamRunResult } from '../../src/stage3/streamSampler.js';

function countP(result: StreamRunResult): number {
  return result.packets.reduce((n, p) => n + p.packet.units.filter((u) => u.scale === '1x1_P').length, 0)
    + result.nextCursor.pendingPUnits.length;
}

describe('用例 6：等效 30fps 步长对齐', () => {
  it('24fps 与 60fps 同速运动：积分产出 P 数一致（±1）', async () => {
    const r24 = await runFixtureStream('case06a_fps24.mp4', await makeSlot(join(FIXTURES, 'case06a_fps24.mp4')));
    const r60 = await runFixtureStream('case06b_fps60.mp4', await makeSlot(join(FIXTURES, 'case06b_fps60.mp4')));
    const p24 = countP(r24);
    const p60 = countP(r60);
    expect(p24).toBeGreaterThanOrEqual(3);
    expect(Math.abs(p24 - p60)).toBeLessThanOrEqual(1);
    expectPacketLegal(r24);
    expectPacketLegal(r60);
  });

  it('暗光低对比度大幅运动仍出 P（梯度归一化剥离量纲）', async () => {
    const r = await runFixtureStream('case06c_dark.mp4', await makeSlot(join(FIXTURES, 'case06c_dark.mp4')));
    expect(countP(r)).toBeGreaterThanOrEqual(1);
  });
});
