/**
 * 用例 12：冷区准入与纯过程包生命周期。
 *
 * case05 fixture（FORM_2 密集）：连续两次调用。
 * - FORM_2 纯过程包滑出热区后释放，冷区引用链仅含带 F 锚点的源包；
 * - 冷区数量 ≤ maxColdRefs（4）且为最新的 F 锚点源包；
 * - 历史环与 FUnitCache 尺寸有界。
 */

import { describe, expect, it } from 'vitest';
import { runStreamCallFixture } from './helpers.js';
import { getSessionState } from '../../src/session/state.js';
import { fingerprintOf, getVideoSlot } from '../../src/session/state.js';
import { fixturePath } from './helpers.js';

const SESSION = 'case12-cold-admission';

describe('case12: 冷区准入与纯过程包生命周期', () => {
  it('FORM_2 不入冷区；冷区 ≤4 且最新；环与缓存有界', async () => {
    await runStreamCallFixture('case05_motion.mp4', SESSION, {}, { defaultStreamWindowMs: 2000 });
    await runStreamCallFixture('case05_motion.mp4', SESSION, {}, { defaultStreamWindowMs: 2200 });

    const session = getSessionState(SESSION);
    const slot = getVideoSlot(session, fingerprintOf(fixturePath('case05_motion.mp4')));

    // 冷区仅含 F 锚点源包
    expect(slot.epoch.coldRefs.length).toBeGreaterThan(0);
    expect(slot.epoch.coldRefs.length).toBeLessThanOrEqual(4);
    for (const c of slot.epoch.coldRefs) {
      expect(c.anchorFId).toBeGreaterThan(0);
      const src = slot.history.packets.find(
        (e) => e.packet.packetId === c.sourcePacketId,
      );
      expect(src).toBeTruthy();
      expect(src!.packet.layoutForm).not.toBe('FORM_2_COMPACT_4P');
    }

    // 冷区为最新锚点：sourcePacketId 单调不降
    const srcIds = slot.epoch.coldRefs.map((c) => c.sourcePacketId);
    for (let i = 1; i < srcIds.length; i++) {
      expect(srcIds[i]).toBeGreaterThan(srcIds[i - 1]);
    }

    // 环有界：冷区 + 热区（2）+ 尚未滑出的新包冗余 ≤ 上界
    expect(slot.history.packets.length).toBeLessThanOrEqual(4 + 2 + 8);

    // FUnitCache（会话级）：条目 = 环内带 F 锚点的包（冷区 ∪ 热区），纯过程包滑出即释放
    const anchoredInRing = slot.history.packets.filter((e) => e.packet.anchorFId !== null);
    expect(anchoredInRing.every((e) => session.fUnitCache.has(e.packet.anchorFId!))).toBe(true);
    expect(session.fUnitCache.size).toBe(anchoredInRing.length);
  }, 240_000);
});
