/**
 * case 1（旋转校正）与 case 2（末尾避让）— Stage 0 probe 单元/e2e 用例。
 * fixture 由 test/fixtures/gen 在 beforeAll 幂等生成。
 */

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildProbeResult, extractRotation, normalizeRotation, probeVideo, type FfprobeJson } from '../../../src/stage0/probe.js';
import { runDeterministicInspection, resolveTargets } from '../../../src/stage3/deterministicRouter.js';
import { estimateLastPtsMs, parseRational, secondsToMs } from '../../../src/utils/pts.js';
import { resolveBinPaths } from '../../../src/utils/ffmpegBin.js';

const bins = resolveBinPaths();

function ffprobeJson(path: string): FfprobeJson {
  const run = spawnSync(
    bins.ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
    { encoding: 'utf8', windowsHide: true },
  );
  if (run.status !== 0) throw new Error(`ffprobe 失败：${run.stderr}`);
  return JSON.parse(run.stdout) as FfprobeJson;
}

describe('normalizeRotation / extractRotation（纯函数）', () => {
  it('归一化到 {0,90,180,270}，负角与 >360 角折算', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-270)).toBe(90);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(undefined)).toBe(0);
    expect(normalizeRotation(Number.NaN)).toBe(0);
  });

  it('Display Matrix 优先于 tags.rotate；旧式 tags.rotate 单独生效', () => {
    const matrixStream = {
      tags: { rotate: '180' },
      side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
    };
    expect(extractRotation(matrixStream)).toBe(270);
    const legacyStream = { tags: { rotate: '90' } };
    expect(extractRotation(legacyStream)).toBe(90);
  });

  it('tags.rotate 合成输入走显示坐标系交换（ffmpeg 8 无法生成该标签，用合成 JSON 覆盖）', () => {
    const result = buildProbeResult({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1080,
          height: 1920,
          avg_frame_rate: '30/1',
          tags: { rotate: '90' },
        },
      ],
      format: { duration: '2.000000' },
    });
    expect(result.rotation).toBe(90);
    expect(result.displayWidth).toBe(1920);
    expect(result.displayHeight).toBe(1080);
  });
});

describe('case 1 — 竖拍旋转校正（e2e）', () => {
  it('rot90：显示坐标系交换（1080x1920 编码 → 1920x1080 显示）', async () => {
    const result = await probeVideo('test/fixtures/media/case01_rot90.mp4', { ffprobePath: bins.ffprobe });
    expect(result.codedWidth).toBe(1080);
    expect(result.codedHeight).toBe(1920);
    expect(result.rotation).toBe(90);
    expect(result.displayWidth).toBe(1920);
    expect(result.displayHeight).toBe(1080);
  });

  it('rot270：ffprobe 报告 rotation=-90，归一化为 270 并交换宽高', async () => {
    const result = await probeVideo('test/fixtures/media/case01_rot270.mp4', { ffprobePath: bins.ffprobe });
    expect(result.rotation).toBe(270);
    expect(result.displayWidth).toBe(1920);
    expect(result.displayHeight).toBe(1080);
  });
});

describe('case 2 — 末尾 duration 避让（e2e + 纯函数）', () => {
  it('estimateLastPtsMs 保守估算：3000ms − 2×33.3ms = 2933ms', () => {
    expect(estimateLastPtsMs(3000, 30)).toBe(2933);
    expect(estimateLastPtsMs(3000, 0)).toBe(3000);
    expect(estimateLastPtsMs(0, 30)).toBe(0);
  });

  it('pts 工具：secondsToMs 取整、时钟形态（Matroska tags.DURATION）、parseRational 有理数解析', () => {
    expect(secondsToMs('2.966666')).toBe(2967);
    expect(secondsToMs(undefined)).toBe(0);
    // HH:MM:SS 时钟形态：parseFloat 会在 ':' 截断得 0，必须按时钟解析
    expect(secondsToMs('00:02:03.123000000')).toBe(123123);
    expect(secondsToMs('0:00:05')).toBe(5000);
    expect(secondsToMs('01:10:05,500')).toBe(4205500);
    expect(parseRational('30000/1001')).toBeCloseTo(29.970029, 5);
    expect(parseRational('30/1')).toBe(30);
    expect(parseRational('0/0')).toBe(0);
  });

  it('逐帧路径：plain 末帧 PTS=2966/2967，小于标称 3000ms', async () => {
    const result = await probeVideo('test/fixtures/media/case02_plain.mp4', { ffprobePath: bins.ffprobe });
    expect(result.durationMs).toBe(3000);
    expect([2966, 2967]).toContain(result.lastPtsMs);
    expect(result.lastPtsMs).toBeLessThan(3000);
  });

  it('黑尾拉偏标称时长：容器时长 > 主源时长，last_pts_ms 取实际末帧', async () => {
    const result = await probeVideo('test/fixtures/media/case02_blacktail.mp4', { ffprobePath: bins.ffprobe });
    expect(result.durationMs).toBeGreaterThan(3000);
    expect(result.lastPtsMs).toBeLessThanOrEqual(result.durationMs);
    expect(result.lastPtsMs).toBeGreaterThan(2900);
  });

  it('timestamps 越界钳制：[-100, 2980, 99999] → [0, last_pts_ms]', async () => {
    const probe = await probeVideo('test/fixtures/media/case02_plain.mp4', { ffprobePath: bins.ffprobe });
    const targets = resolveTargets(
      { action: 'timestamps', timestamps_ms: [-100, 2980, 99999] },
      probe,
    );
    expect(targets).toEqual([0, probe.lastPtsMs]);
  });

  it('定点抽帧末尾避让：超出末帧的时间戳钳制到 last_pts_ms 并成功出包（空帧回退路径）', async () => {
    const probe = await probeVideo('test/fixtures/media/case02_plain.mp4', { ffprobePath: bins.ffprobe });
    const result = await runDeterministicInspection(
      'test/fixtures/media/case02_plain.mp4',
      probe,
      { action: 'timestamps', timestamps_ms: [2990], focus: 'detail' },
      {
        ffmpegPath: bins.ffmpeg,
        renderVisualId: false,
        packetIdStart: 1,
        globalIdStart: 1,
        appliedIntentId: 'intent_1',
      },
    );
    expect(result.sampledPtsMs).toEqual([probe.lastPtsMs]);
    expect(result.packets).toHaveLength(1);
    expect(result.packets[0].packet.layoutForm).toBe('FORM_3_COMPACT_1F');
    expect(result.packets[0].packet.units[0].timestampMs).toBe(probe.lastPtsMs);
  });
});

describe('probe 元数据完整性（case 18 前置，e2e）', () => {
  it('字段集合与类型齐全', async () => {
    const result = await probeVideo('test/fixtures/media/case02_plain.mp4', { ffprobePath: bins.ffprobe });
    expect(Object.keys(result).sort()).toEqual(
      [
        'audioStreams',
        'avgFps',
        'codedHeight',
        'codedWidth',
        'codec',
        'displayHeight',
        'displayWidth',
        'durationMs',
        'lastPtsMs',
        'rotation',
        'subtitleStreams',
        'videoStreamIndex',
      ].sort(),
    );
    expect(result.avgFps).toBeCloseTo(30, 5);
    expect(result.codec).toBe('h264');
    expect(result.videoStreamIndex).toBe(0);
    expect(Array.isArray(result.audioStreams)).toBe(true);
    expect(Array.isArray(result.subtitleStreams)).toBe(true);
  });

  it('封面流（attached_pic=1）被跳过：取首个真实视频流，videoStreamIndex 指向其视频流序', () => {
    const result = buildProbeResult({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 640,
          height: 360,
          avg_frame_rate: '0/0',
          disposition: { attached_pic: 1 },
        },
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1280,
          height: 720,
          avg_frame_rate: '30/1',
        },
      ],
      format: { duration: '2.000000' },
    });
    expect(result.codec).toBe('h264');
    expect(result.codedWidth).toBe(1280);
    expect(result.videoStreamIndex).toBe(1);
  });

  it('全部为封面流时退回首轨（仅封面文件仍可探测元数据）', () => {
    const result = buildProbeResult({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'mjpeg',
          width: 640,
          height: 360,
          avg_frame_rate: '0/0',
          disposition: { attached_pic: 1 },
        },
      ],
      format: { duration: '2.000000' },
    });
    expect(result.codec).toBe('mjpeg');
    expect(result.videoStreamIndex).toBe(0);
  });

  it('不存在视频流时报 PFSTREAM_PROBE_NO_VIDEO', () => {
    try {
      buildProbeResult({ streams: [{ codec_type: 'audio' }] });
      expect.unreachable('应当抛出 PFSTREAM_PROBE_NO_VIDEO');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('PFSTREAM_PROBE_NO_VIDEO');
    }
  });
});
