/**
 * 用例 15：预算截断顺序与 56MiB 水位（编排级）。
 *
 * case14_slow fixture（慢速运动长片）连续调用累积历史后，用 intent.max_packets=3
 * 触发预检截断：优先丢旧冷区引用，其次旧热区，最后切分增量；返回包数 = 3。
 */

import { describe, expect, it } from 'vitest';
import { runStreamCallFixture } from './helpers.js';

const SESSION = 'case15-budget';

describe('case15: 预算截断顺序（编排级）', () => {
  it('max_packets=3 时从旧冷区开始丢弃且返回恰 3 包', async () => {
    // 累积历史：两次满窗口调用（band 段持续运动 → PEAK_FULL/F 锚点入环）
    await runStreamCallFixture('case14_slow.mp4', SESSION, {}, { defaultStreamWindowMs: 1800 });
    await runStreamCallFixture('case14_slow.mp4', SESSION, {}, { defaultStreamWindowMs: 1800 });

    // 第三窗 3600-5400：band 至 4000 仍有运动 → 产生新包后截断
    const third = await runStreamCallFixture(
      'case14_slow.mp4',
      SESSION,
      { max_packets: 3 },
      { defaultStreamWindowMs: 1800 },
    );

    const modes = third.packets.map((a) => a.packet.historyMode);
    expect(third.packets).toHaveLength(3);

    const dropped = third.telemetry.precheck.dropped;
    expect(dropped.length).toBeGreaterThan(0);
    // 第一丢弃项为最旧冷区
    expect(dropped[0].kind).toBe('cold');
    // 丢弃序列内 kind 分段非降：cold…→hot…→new…
    const order = { cold: 0, hot: 1, new: 2 } as const;
    for (let i = 1; i < dropped.length; i++) {
      expect(order[dropped[i].kind]).toBeGreaterThanOrEqual(order[dropped[i - 1].kind]);
    }
    // 截断后仍有新包可消费（未全丢冷热）
    expect(modes).toContain('initial');
    // 历史引用足以满足预算时增量不被切分（truncatedCurrent 仅在丢 new 时置位）
    expect(third.telemetry.precheck.truncatedCurrent).toBe(false);
  }, 240_000);
});
