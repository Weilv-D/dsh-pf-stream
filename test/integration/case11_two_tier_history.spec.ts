/**
 * 用例 11：两级历史引用流转与元数据一致性。
 *
 * case05 fixture（2.5s 周期循环）三次连续调用（同会话），每窗口含运动事件：
 * - 冷区（热窗之外）以 anchor_only_ref 引用 FORM_3 独立载体，元数据全集正确；
 * - 热区（最近 2 包）以 full_strip_ref 引用原条带；
 * - 新包 historyMode=initial；
 * - 输出顺序：冷区 → 热区 → 增量。
 */

import { describe, expect, it } from 'vitest';
import { runStreamCallFixture } from './helpers.js';

const SESSION = 'case11-two-tier';

describe('case11: 两级历史引用流转', () => {
  it('第三次调用输出冷/热/新三层且元数据一致', async () => {
    await runStreamCallFixture('case05_motion.mp4', SESSION, {}, { defaultStreamWindowMs: 1500 });
    await runStreamCallFixture('case05_motion.mp4', SESSION, {}, { defaultStreamWindowMs: 1500 });
    const third = await runStreamCallFixture(
      'case05_motion.mp4',
      SESSION,
      {},
      { defaultStreamWindowMs: 1000 },
    );

    const packets = third.packets.map((a) => a.packet);
    const modes = packets.map((p) => p.historyMode);

    // 三层齐备
    expect(modes).toContain('anchor_only_ref');
    expect(modes).toContain('full_strip_ref');
    expect(modes).toContain('initial');

    // 顺序：所有 cold 在所有 hot 之前，所有 hot 在所有 new 之前
    const firstHot = modes.indexOf('full_strip_ref');
    const firstNew = modes.indexOf('initial');
    const lastCold = modes.lastIndexOf('anchor_only_ref');
    expect(lastCold).toBeLessThan(firstHot);
    expect(firstHot).toBeLessThan(firstNew);

    // 冷区元数据全集
    for (const p of packets.filter((x) => x.historyMode === 'anchor_only_ref')) {
      expect(p.layoutForm).toBe('FORM_3_COMPACT_1F');
      expect(p.canvasSize).toEqual([672, 672]);
      expect(p.anchorOnlyRefPacketId).toBeGreaterThan(0);
      expect(p.spatialRemap).toBe('anchor_to_full_canvas');
      expect(p.stripSha256).toBeNull();
      expect(p.anchorFId).not.toBeNull();
      expect(p.anchorFSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.units).toHaveLength(1);
      const u = p.units[0];
      expect(u.scale).toBe('2x2_F');
      expect(u.tokenGridBbox).toEqual([0, 0, 16, 16]);
      expect(u.contentPixelBbox).toEqual([0, 0, 672, 672]);
    }

    // 热区元数据
    for (const p of packets.filter((x) => x.historyMode === 'full_strip_ref')) {
      expect(p.historyMode).toBe('full_strip_ref');
      expect(p.stripSha256).toBeTruthy();
      expect(p.anchorOnlyRefPacketId).toBeNull();
      expect(p.spatialRemap).toBeNull();
    }

    // 新包
    for (const p of packets.filter((x) => x.historyMode === 'initial')) {
      expect(p.anchorOnlyRefPacketId).toBeNull();
      expect(p.spatialRemap).toBeNull();
    }

    // 遥测
    expect(third.telemetry.precheck.kept.length).toBe(packets.length);
    expect(third.coldRefCount).toBe(
      packets.filter((p) => p.historyMode === 'anchor_only_ref').length,
    );
    expect(third.hotRefCount).toBe(
      packets.filter((p) => p.historyMode === 'full_strip_ref').length,
    );
  }, 240_000);
});
