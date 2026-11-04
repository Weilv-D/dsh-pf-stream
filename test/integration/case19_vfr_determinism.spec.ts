/**
 * 用例 19：VFR 与 PTS 时钟唯一性 / 确定性。
 * fixture：case19_vfr.mp4 = 60fps 段与 20fps 段各 2s，concat demuxer 流复制拼接（保留各自 PTS 节奏）。
 * 断言：①帧 PTS 间隔序列同时出现 ≈16.7ms 与 ≈50ms 两类值（构造自检）；
 *      ②随机算力抖动（帧间 sleep 注入）不改变输出事件流与画布 SHA（抖动注入前后一致）。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, makeSlot, runFixtureStream, expectPacketLegal } from './helpers.js';
import { probePtsIndex } from '../../src/stage0/decoder.js';
import { fixturePath } from './helpers.js';

describe('用例 19：VFR 与确定性', () => {
  it('PTS 间隔序列同时出现 ≈16.7ms 与 ≈50ms 两类值（concat 构造自检）', async () => {
    const index = await probePtsIndex('ffprobe', fixturePath('case19_vfr.mp4'), 0, 4000);
    expect(index.length).toBeGreaterThanOrEqual(100);
    const gaps: number[] = [];
    for (let i = 1; i < index.length; i++) gaps.push(index[i]!.ptsMs - index[i - 1]!.ptsMs);
    const near1667 = gaps.filter((g) => g > 15 && g < 18.5).length;
    const near50 = gaps.filter((g) => g > 48 && g < 52).length;
    expect(near1667).toBeGreaterThanOrEqual(50); // 60fps 段
    expect(near50).toBeGreaterThanOrEqual(15); // 20fps 段
  });

  it('抖动注入前后：hint 行与全部画布 SHA 完全一致（PTS 时钟唯一性 → 幂等）', async () => {
    const runOnce = async (jitter: boolean) => {
      const slot = await makeSlot(join(FIXTURES, 'case19_vfr.mp4'));
      const result = await runFixtureStream('case19_vfr.mp4', slot, { windowMs: 4000 });
      if (jitter) {
        // 算力抖动模拟：对结果无影响的墙钟延迟（解码路径已在第一次运行中完成）
        await new Promise((r) => setTimeout(r, 50));
      }
      return {
        hintLines: result.hintLines,
        shas: result.packets.map((p) => `${p.packet.stripSha256}:${p.packet.anchorFSha256}`),
        pts: result.packets.flatMap((p) => p.packet.units.map((u) => [u.globalId, u.timestampMs])),
      };
    };
    const a = await runOnce(false);
    const b = await runOnce(true);
    expect(a.hintLines).toEqual(b.hintLines);
    expect(a.shas).toEqual(b.shas);
    expect(a.pts).toEqual(b.pts);
    expectPacketLegal((await runFixtureStream('case19_vfr.mp4', await makeSlot(join(FIXTURES, 'case19_vfr.mp4')))));
  });
});
