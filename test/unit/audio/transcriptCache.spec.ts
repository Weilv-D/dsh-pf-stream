/** A9：磁盘转写缓存（指纹 / 原子读写 / 缺口计算 / 区间合并）。 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cachedSegmentsFor,
  engineFingerprint,
  mergeInterval,
  missingRanges,
  readTranscriptCache,
  videoFingerprint,
  writeTranscriptCache,
  type TranscriptInterval,
} from '../../../src/audio/transcriptCache.js';
import type { AsrSettings, TranscriptSegment } from '../../../src/audio/types.js';
import { fixturePath } from '../../integration/helpers.js';

const seg = (id: number, startMs: number, text: string): TranscriptSegment => ({
  segId: id, startMs, endMs: startMs + 500, text, source: 'asr',
});

const interval = (startMs: number, endMs: number, segs: TranscriptSegment[]): TranscriptInterval => ({
  startMs, endMs, source: 'asr', segments: segs,
});

describe('A9 转写缓存', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-cache-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('videoFingerprint：同文件稳定，mtime 变化失效', async () => {
    const copy = join(dir, 'fp.mp4');
    cpSync(fixturePath('case01_base.mp4'), copy);
    const a = await videoFingerprint(copy);
    const b = await videoFingerprint(copy);
    expect(a).toBe(b);
    utimesSync(copy, new Date(), new Date(Date.now() + 5000));
    expect(await videoFingerprint(copy)).not.toBe(a);
  });

  it('engineFingerprint：本地与云端不共用缓存，密钥不参与', () => {
    const local: AsrSettings = {
      provider: 'local_cli',
      baseUrl: null,
      model: 'C:/tools/whisper-cli.exe',
      apiKey: null,
      language: 'auto',
      args: ['-m', 'model.bin'],
      timeoutMs: 300000,
      maxConcurrency: 1,
    };
    const cloud: AsrSettings = {
      provider: 'openai_verbose',
      baseUrl: 'https://api.example.com',
      model: 'whisper-1',
      apiKey: 'sk-a',
      language: 'auto',
      args: null,
      timeoutMs: 20000,
      maxConcurrency: 2,
    };
    expect(engineFingerprint(local)).not.toBe(engineFingerprint(cloud));
    expect(engineFingerprint(cloud)).toBe(engineFingerprint({ ...cloud, apiKey: 'sk-b' }));
  });

  it('write/read 原子往返；坏文档返回 null', async () => {
    const fp = 'f'.repeat(32);
    const its = [interval(0, 2000, [seg(1, 100, '甲')])];
    await writeTranscriptCache(dir, fp, its);
    expect(await readTranscriptCache(dir, fp)).toEqual(its);
    writeFileSync(join(dir, `${fp}.json`), '{broken', 'utf8');
    expect(await readTranscriptCache(dir, fp)).toBeNull();
  });

  it('missingRanges：部分覆盖只补缺口（±1s 缝合余量）', () => {
    const its = [interval(0, 2000, [])];
    expect(missingRanges(its, [0, 8000])).toEqual([[3000, 8000]]);
    expect(missingRanges(its, [0, 2500])).toEqual([]);
    // 中段缺口
    const its2 = [interval(0, 2000, []), interval(6000, 8000, [])];
    expect(missingRanges(its2, [0, 8000])).toEqual([[3000, 5000]]);
  });

  it('mergeInterval：重叠合并、段按起点去重', () => {
    const a = interval(0, 2000, [seg(1, 100, '甲'), seg(2, 1200, '乙')]);
    const b = interval(1800, 4000, [seg(3, 1200, '乙'), seg(4, 2500, '丙')]);
    const merged = mergeInterval([a], b);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ startMs: 0, endMs: 4000 });
    expect(merged[0]!.segments.map((s) => s.text)).toEqual(['甲', '乙', '丙']);
  });

  it('cachedSegmentsFor：窗口相交段按时间序', () => {
    // 甲横跨窗口左缘（区间 0–2000，段 1200–1900 与窗口 1500–5000 相交）
    const its = [interval(0, 2000, [seg(1, 1200, '甲')]), interval(4000, 6000, [seg(2, 4100, '乙')])];
    const got = cachedSegmentsFor(its, [1500, 5000]);
    expect(got.map((s) => s.text)).toEqual(['甲', '乙']);
    // 与窗口无交集的段不返回
    expect(cachedSegmentsFor(its, [2200, 3000])).toEqual([]);
  });
});
