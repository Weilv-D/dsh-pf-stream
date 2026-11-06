/**
 * 解码 argv 纯函数单测：-map 流选择与 ffprobe 索引流（v:N）对齐。
 *
 * ffmpeg 缺省视频选流按分辨率优先；封面流分辨率高于主视频或多真实视频流
 * 文件时，缺省选流与 ffprobe v:N 分歧 → PTS/几何错乱。两处解码 argv 均须
 * 显式 -map 0:v:N。
 */

import { describe, expect, it } from 'vitest';
import { pointArgv, rangeArgv } from '../../../src/stage0/decoder.js';

describe('解码 argv 流选择', () => {
  it('pointArgv 显式 -map 0:v:N', () => {
    const argv = pointArgv('v.mp4', 1234, 2);
    const i = argv.indexOf('-map');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('0:v:2');
  });

  it('rangeArgv 显式 -map 0:v:N', () => {
    const argv = rangeArgv('v.mp4', 0, 4000, { outW: 320, outH: 180, vf: ['scale=320:180'] }, 1);
    const i = argv.indexOf('-map');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv[i + 1]).toBe('0:v:1');
  });

  it('主视频流序为 0 时仍显式 -map（消除缺省选流的分辨率歧义）', () => {
    expect(pointArgv('v.mp4', 0, 0)).toEqual(expect.arrayContaining(['-map', '0:v:0']));
    expect(rangeArgv('v.mp4', 0, 1000, { outW: 320, outH: 180, vf: [] }, 0)).toEqual(
      expect.arrayContaining(['-map', '0:v:0']),
    );
  });
});
