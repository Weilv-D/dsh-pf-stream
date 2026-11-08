/** A2/A5：声学 VAD（语音岛 / 静音短路 / 谷底切分）。 */
import { describe, expect, it } from 'vitest';
import { canonicalizeWav, DEFAULT_CHUNK_PLAN, isSilentWindow, lastAstatsMatch, planChunks, planHostChunks, planIslandChunks, scanVad, sliceAudio } from '../../../src/audio/acousticVad.js';
import type { VadResult } from '../../../src/audio/types.js';
import { fixturePath } from '../../integration/helpers.js';

const vad = (silence: Array<[number, number]>, islands: Array<[number, number]>): VadResult => ({
  silence, islands, rmsDb: -20, peakDb: -6, activeRatio: 0.3,
});

describe('A2 静音短路判定', () => {
  it('活跃占比 < 5% 判静音', () => {
    expect(isSilentWindow({ ...vad([], []), activeRatio: 0.04 })).toBe(true);
    expect(isSilentWindow({ ...vad([], []), activeRatio: 0.27 })).toBe(false);
  });
  it('峰值 < -45dBFS 判静音', () => {
    expect(isSilentWindow({ ...vad([], []), peakDb: -50, activeRatio: 0.9 })).toBe(true);
  });
  it('null VAD 不短路', () => {
    expect(isSilentWindow(null)).toBe(false);
  });
});

describe('astats 电平解析（整窗累积值）', () => {
  it('逐帧打印下取最后一个匹配（EOS 块为整窗值）', () => {
    const stderr = [
      '[Parsed_astats_1 @ ...] Frame 1',
      'RMS level dB:         -12.4',
      'Peak level dB:        -3.1',
      '[Parsed_astats_1 @ ...] Frame 2',
      'RMS level dB:         -31.7',
      'Peak level dB:        -9.9',
      '[Parsed_astats_1 @ ...] Overall',
      'RMS level dB:         -40.2',
      'Peak level dB:        -44.6',
    ].join('\n');
    expect(lastAstatsMatch(stderr, /RMS level dB:\s*(-?[\d.]+|-?inf)/g)).toBe('-40.2');
    expect(lastAstatsMatch(stderr, /Peak level dB:\s*(-?[\d.]+|-?inf)/g)).toBe('-44.6');
  });

  it('无匹配返回 undefined', () => {
    expect(lastAstatsMatch('', /RMS level dB:\s*(-?[\d.]+|-?inf)/g)).toBeUndefined();
  });
});

describe('A5 谷底切分规划', () => {
  it('切点落在最深的静音谷中点 ±50ms，覆盖连续无跳变', () => {
    // 200s 窗口：每轮 [start+45s, start+75s] 频带内取最深谷中点切割
    const silences: Array<[number, number]> = [
      [10_000, 20_000], [30_000, 40_000], [50_000, 60_000], [70_000, 80_000],
      [90_000, 100_000], [110_000, 120_000], [130_000, 140_000], [150_000, 160_000], [170_000, 180_000],
    ];
    const chunks = planChunks([0, 200_000], vad(silences, []));
    expect(chunks[0]?.[0]).toBe(0);
    expect(chunks.at(-1)?.[1]).toBe(200_000);
    // 相邻块首尾相接
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.[0]).toBe(chunks[i - 1]?.[1]);
    }
    const cutMids = chunks.slice(1).map((c) => c[0]);
    for (const mid of [55_000, 115_000, 175_000]) {
      const hit = cutMids.find((m) => Math.abs(m - mid) <= 50);
      expect(hit, `期望切点 ${mid}，实际 ${JSON.stringify(cutMids)}`).toBeDefined();
    }
    for (const c of chunks) expect(c[1] - c[0]).toBeLessThanOrEqual(DEFAULT_CHUNK_PLAN.maxMs);
  });

  it('无谷底时按 60s 硬切', () => {
    const chunks = planChunks([0, 150_000], vad([], []));
    expect(chunks).toEqual([[0, 60_000], [60_000, 120_000], [120_000, 150_000]]);
  });

  it('planIslandChunks：岛逐切，>30s 硬切', () => {
    expect(planIslandChunks([0, 10_000], vad([], [[1_000, 3_000]]))).toEqual([[1_000, 3_000]]);
    expect(planIslandChunks([0, 80_000], vad([], [[0, 80_000]]))).toEqual([[0, 30_000], [30_000, 60_000], [60_000, 80_000]]);
  });

  it('planHostChunks：岛按 15s 切；无岛时也硬切，避免整窗超限', () => {
    expect(planHostChunks([0, 10_000], vad([], [[1_000, 3_000]]))).toEqual([[1_000, 3_000]]);
    expect(planHostChunks([0, 80_000], vad([], [[0, 80_000]]))).toEqual([
      [0, 15_000], [15_000, 30_000], [30_000, 45_000], [45_000, 60_000], [60_000, 75_000], [75_000, 80_000],
    ]);
    expect(planHostChunks([0, 70_000], null)).toEqual([
      [0, 15_000], [15_000, 30_000], [30_000, 45_000], [45_000, 60_000], [60_000, 70_000],
    ]);
  });
});

describe('A2/A5 fixture 实测（ffmpeg silencedetect）', () => {
  it('case_audio_silence：语音岛 ≈ [800,1600]，尾部窗短路', async () => {
    const full = await scanVad(fixturePath('case_audio_silence.mp4'), [0, 3000], { ffmpegPath: 'ffmpeg' });
    expect(full).not.toBeNull();
    expect(full!.islands.length).toBeGreaterThanOrEqual(1);
    const [a, b] = full!.islands[0]!;
    expect(Math.abs(a - 800)).toBeLessThanOrEqual(250);
    expect(Math.abs(b - 1600)).toBeLessThanOrEqual(250);

    const tail = await scanVad(fixturePath('case_audio_silence.mp4'), [1800, 3000], { ffmpegPath: 'ffmpeg' });
    expect(isSilentWindow(tail)).toBe(true);
  }, 60_000);

  it('case_audio_long：80s 窗单刀切在最深谷中点（≈55s）±600ms', async () => {
    const result = await scanVad(fixturePath('case_audio_long.mp4'), [0, 80_000], { ffmpegPath: 'ffmpeg' });
    expect(result).not.toBeNull();
    expect(result!.islands.length).toBeGreaterThanOrEqual(3);
    // 80s ≤ 75s 上限不满足 → 恰需一刀：[45,75]s 频带最深谷 [50,60]s 中点
    const chunks = planChunks([0, 80_000], result);
    expect(chunks).toHaveLength(2);
    const cut = chunks[1]![0];
    expect(Math.abs(cut - 55_000)).toBeLessThanOrEqual(600);
    expect(chunks[0]![0]).toBe(0);
    expect(chunks[1]![1]).toBe(80_000);
  }, 120_000);
});

describe('WAV canonical 头', () => {
  it('把 0xFFFFFFFF 的 RIFF/data 长度改成真实字节数', () => {
    const bytes = Buffer.alloc(44 + 3200);
    bytes.write('RIFF', 0, 'ascii');
    bytes.writeUInt32LE(0xffffffff, 4);
    bytes.write('WAVE', 8, 'ascii');
    bytes.write('fmt ', 12, 'ascii');
    bytes.writeUInt32LE(16, 16);
    bytes.write('data', 36, 'ascii');
    bytes.writeUInt32LE(0xffffffff, 40);
    const out = canonicalizeWav(bytes);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out.readUInt32LE(40)).toBe(3200);
    expect(out.toString('ascii', 36, 40)).toBe('data');
  });

  it('已有 canonical 头时不改内容', () => {
    const bytes = Buffer.alloc(44 + 16);
    bytes.write('RIFF', 0, 'ascii');
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVE', 8, 'ascii');
    bytes.write('fmt ', 12, 'ascii');
    bytes.writeUInt32LE(16, 16);
    bytes.write('data', 36, 'ascii');
    bytes.writeUInt32LE(16, 40);
    const out = canonicalizeWav(bytes);
    expect(out.equals(bytes)).toBe(true);
  });

  it('带 LIST 块的 WAV 被重建成 canonical 头', () => {
    const payload = Buffer.from('abcd');
    const bytes = Buffer.alloc(12 + 24 + 18 + 8 + payload.length);
    bytes.write('RIFF', 0, 'ascii');
    bytes.writeUInt32LE(0xffffffff, 4);
    bytes.write('WAVE', 8, 'ascii');
    bytes.write('fmt ', 12, 'ascii');
    bytes.writeUInt32LE(16, 16);
    bytes.write('LIST', 36, 'ascii');
    bytes.writeUInt32LE(10, 40);
    bytes.write('data', 54, 'ascii');
    bytes.writeUInt32LE(0xffffffff, 58);
    payload.copy(bytes, 62);
    const out = canonicalizeWav(bytes);
    expect(out.toString('ascii', 12, 16)).toBe('fmt ');
    expect(out.toString('ascii', 36, 40)).toBe('data');
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out.readUInt32LE(40)).toBe(payload.length);
    expect(out.subarray(44).toString()).toBe('abcd');
  });

  it('WAV 切片输出 canonical 44 字节头', async () => {
    const out = await sliceAudio(
      fixturePath('case_audio_silence.mp4'),
      [0, 1000],
      'wav',
      { ffmpegPath: 'ffmpeg' },
    );
    expect(out.mimeType).toBe('audio/wav');
    expect(out.bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(out.bytes.toString('ascii', 36, 40)).toBe('data');
    expect(out.bytes.readUInt32LE(4)).toBe(out.bytes.length - 8);
    expect(out.bytes.readUInt32LE(40)).toBe(out.bytes.length - 44);
  }, 60_000);
});
