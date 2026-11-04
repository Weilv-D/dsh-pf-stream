/**
 * 用例 5：流式单遍顺序解码与单槽位擂台内存边界。
 * fixture：case05_motion.mp4（640×360@30fps 4s，左右半屏对翻 + 1.5Hz 亮度调制，
 * 感知域 d=1.0 饱和恒定，ρ 随调制出现波峰）。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, makeSlot, runFixtureStream, expectPacketLegal } from './helpers.js';

describe('用例 5：单遍顺序解码与内存边界', () => {
  it('4s@30fps 窗口单遍解码 ≈120 帧，全部步进（ΔPTS≥33.3ms 门）', async () => {
    const slot = await makeSlot(join(FIXTURES, 'case05_motion.mp4'));
    const result = await runFixtureStream('case05_motion.mp4', slot);
    expect(result.telemetry.framesDecoded).toBeGreaterThanOrEqual(116);
    expect(result.telemetry.framesDecoded).toBeLessThanOrEqual(124);
    expect(result.telemetry.framesStepped).toBeGreaterThanOrEqual(result.telemetry.framesDecoded - 2);
    // 窗口覆盖整流（4000ms 窗 ≥ 4s 视频）→ 窗口末端钳制到流末帧 → 流耗尽
    expect(result.telemetry.stopReason).toBe('end_of_stream');
    expectPacketLegal(result);
  });

  it('持续运动触发 PEAK_FULL/PEAK_TIMEOUT 发包，F 冷却期内降级 FORM_2 纯 4P', async () => {
    const slot = await makeSlot(join(FIXTURES, 'case05_motion.mp4'));
    const result = await runFixtureStream('case05_motion.mp4', slot);
    expect(result.packets.length).toBeGreaterThanOrEqual(2);
    const triggers = new Set(result.packets.map((p) => p.packet.triggerPath));
    for (const t of triggers) expect(['PEAK_FULL', 'PEAK_TIMEOUT', 'SETTLE']).toContain(t);
    const withF = result.packets.filter((p) => p.packet.anchorFId !== null);
    const pure4P = result.packets.filter((p) => p.packet.layoutForm === 'FORM_2_COMPACT_4P');
    expect(withF.length).toBeGreaterThanOrEqual(1);
    expect(pure4P.length).toBeGreaterThanOrEqual(1); // 4s > T_cool=1500 必出现冷却期纯 4P
    for (const p of pure4P) {
      expect(p.packet.anchorFId).toBeNull();
      expect(p.packet.anchorFSha256).toBeNull();
      expect(p.packet.units).toHaveLength(4);
      expect(p.packet.units.every((u) => u.scale === '1x1_P')).toBe(true);
    }
  });

  it('游标续流：P 队列有界（≤4），MOTION 快照与 lastConsumedPtsMs 回写', async () => {
    const slot = await makeSlot(join(FIXTURES, 'case05_motion.mp4'));
    const result = await runFixtureStream('case05_motion.mp4', slot);
    expect(result.nextCursor.pendingPUnits.length).toBeLessThanOrEqual(4);
    // fixture 周期 2.5s（0.15 渐入+0.85 翻转+0.5 渐出+1.0 静止尾）；
    // 4s 窗口终点落在静止段，SETTLE 锁定后快照为 STATIC
    expect(result.nextCursor.snapshot.state).toBe('STATIC');
    expect(result.nextCursor.lastConsumedPtsMs).toBeGreaterThan(3900);
  });

  it('单遍契约：单次 ffmpeg spawn、至多一次 -ss 寻址、擂台槽位峰值 ≤2', async () => {
    const slot = await makeSlot(join(FIXTURES, 'case05_motion.mp4'));
    const result = await runFixtureStream('case05_motion.mp4', slot);
    // 单遍顺序解码：整个流式窗口只 spawn 一次 ffmpeg（窗口起点对齐后顺序推进）
    expect(result.telemetry.ffmpegSpawns).toHaveLength(1);
    // 寻址只允许出现在 spawn 参数首部（对齐用），帧推进阶段零 -ss 重启
    const ssCount = result.telemetry.ffmpegSpawns[0].filter((a) => a === '-ss').length;
    expect(ssCount).toBeLessThanOrEqual(1);
    // 单槽位擂台：MOTION 擂台与 SETTLE 观察窗各至多 1 个 672 槽位
    expect(result.telemetry.arenaMaxHeld).toBeLessThanOrEqual(2);
    expect(result.telemetry.arenaMaxHeld).toBeGreaterThanOrEqual(1);
  });
});
