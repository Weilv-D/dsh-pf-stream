/**
 * 用例 9：SWITCH 原子状态清理与黑场顺延。
 * fixture：case09_blackcut.mp4 四段：半屏翻转 1.5s → 纯黑 0.25s → 静止灰 1.75s →
 * 完整门控翻转周期 1.9s。黑→灰本身构成第二次硬切，F_switch 按规格原子步骤 6
 * 重捕于首个正常曝光帧（1750ms）。
 * 断言：SWITCH 处原子清理（无跨场景混排、积分器清零后的重新累积）、
 * 黑场期间 F_switch 顺延捕获（时间戳落在 300ms 顺延窗口内）。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, makeSlot, runFixtureStream, expectPacketLegal } from './helpers.js';

const CUT_MS = 1500; // 运动→黑场切换点

describe('用例 9：SWITCH 原子清理与黑场顺延', () => {
  it('切点产生 SWITCH_STATIC 纯 F 包；黑场顺延后 F 时间戳在顺延窗口内（≤300ms 兜底）', async () => {
    const slot = await makeSlot(join(FIXTURES, 'case09_blackcut.mp4'));
    const result = await runFixtureStream('case09_blackcut.mp4', slot, { windowMs: 5400 });
    const switchPackets = result.packets.filter((p) => p.packet.triggerPath === 'SWITCH_STATIC');
    expect(switchPackets.length).toBeGreaterThanOrEqual(1);
    const f = switchPackets[0]!.packet.units[0]!;
    expect(f.timestampMs).toBeGreaterThanOrEqual(CUT_MS);
    expect(f.timestampMs).toBeLessThanOrEqual(CUT_MS + 340); // 300ms 顺延上限（+编码容差）
    expectPacketLegal(result);
  });

  it('旧场景未发出 P 被清空：切点后所有 P 单元时间戳 ≥ 第二段运动起点', async () => {
    const slot = await makeSlot(join(FIXTURES, 'case09_blackcut.mp4'));
    const result = await runFixtureStream('case09_blackcut.mp4', slot, { windowMs: 5400 });
    // 3500ms 起第二段运动（门控翻转）；SWITCH 已在 1500ms 清队，此后发出的 P 只能来自新运动
    const postCutP = result.packets
      .flatMap((p) => p.packet.units)
      .filter((u) => u.scale === '1x1_P' && u.timestampMs > CUT_MS + 400);
    expect(postCutP.length).toBeGreaterThanOrEqual(1);
    expect(postCutP.every((u) => u.timestampMs >= 3300)).toBe(true);
    // 混排检查：切点后发出的包（首单元 ≥ 切点）不含任何切点前的旧场景单元；
    // 切点前发出的包（旧场景自身的 PEAK 包）不参与本检查
    for (const { packet } of result.packets) {
      if (packet.units[0]!.timestampMs >= CUT_MS) {
        expect(packet.units.every((u) => u.timestampMs >= CUT_MS)).toBe(true);
      }
    }
  });
});
