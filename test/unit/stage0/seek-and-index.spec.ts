/**
 * P1（续流 PTS 错位）与 P2-5（索引终点排他）修复回归：
 * - seekSeconds 向下取整：精确 seek 丢弃 pts<目标的帧，目标必须不越过窗口
 *   起点帧（toFixed 四舍五入在 30fps 浮点游标上会进位丢帧、标签整体前移）；
 * - probePtsIndex 终点外扩 1ms：integer-ms 帧率 w1==末帧 PTS 时末帧被 END
 *   排他排除（末帧永不消费）——外扩后包含 pts==w1 的帧。
 */
import { describe, expect, it } from 'vitest';
import { pointArgv, probePtsIndex, rangeArgv, seekSeconds } from '../../../src/stage0/decoder.js';
import { fixturePath } from '../../integration/helpers.js';

describe('seekSeconds（P1 修复回归）', () => {
  it('浮点毫秒向下取整，不越过起点帧', () => {
    // 30fps 帧 19.966667ms：toFixed(3) 会进位到 "19.967"（丢弃该帧），
    // floor 后 "19.966" 保留（实测 sha 一致性验证见审计记录）。
    expect(seekSeconds(19966.666666)).toBe('19.966');
    expect(seekSeconds(33.333333)).toBe('0.033');
    expect(seekSeconds(0)).toBe('0.000');
    // 整数毫秒原样（定点通道目标恒整数，行为不变）
    expect(seekSeconds(66)).toBe('0.066');
    expect(seekSeconds(40000)).toBe('40.000');
  });

  it('rangeArgv/pointArgv 使用 floor 语义的 -ss', () => {
    const geometry = { outW: 320, outH: 240, vf: [] };
    const argv = rangeArgv('v.mp4', 19966.666666, 40000, geometry, 0);
    const ss = argv[argv.indexOf('-ss') + 1]!;
    expect(ss).toBe('19.966');
    const pArgv = pointArgv('v.mp4', 100, 0);
    expect(pArgv[pArgv.indexOf('-ss') + 1]).toBe('0.100');
  });
});

describe('probePtsIndex（P2-5 修复回归，真实 fixture）', () => {
  it('索引包含 pts==w1 的末帧（END 排他补偿）', async () => {
    const path = fixturePath('case01_base.mp4');
    // case01_base: 2s@30fps，末帧 1966.667ms → lastPtsMs=1967（整数）。
    // 旧实现 interval END 排他会丢掉 1966.667 帧；外扩 1ms 后包含。
    const entries = await probePtsIndex('ffprobe', path, 1000, 1967);
    expect(entries.length).toBeGreaterThan(0);
    const ptsList = entries.map((e) => e.ptsMs);
    expect(Math.max(...ptsList)).toBeGreaterThanOrEqual(1967 - 0.5);
  }, 60_000);

  it('已中止 signal → PFSTREAM_EXEC_ABORT（execFile 预检生效）', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      probePtsIndex('ffprobe', fixturePath('case01_base.mp4'), 0, 1000, 0, controller.signal),
    ).rejects.toMatchObject({ code: 'PFSTREAM_EXEC_ABORT' });
  }, 60_000);
});
