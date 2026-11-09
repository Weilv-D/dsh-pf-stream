/**
 * ASR 块失败零诊断缺口修复的回归：失败原因采样（≤5 条）随 AsrRunResult
 * 透出，并经 sidecar 注入 audio.telemetry.failureSamples（工具返回根级可
 * 见）。用坏 ffmpegPath 触发 sliceAudio spawn 失败，不触网。
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcribeWindow } from '../../../src/audio/asrRouter.js';
import { engineFingerprint, readTranscriptCache, videoFingerprint } from '../../../src/audio/transcriptCache.js';
import type { AsrSettings } from '../../../src/audio/types.js';

const SETTINGS: AsrSettings = {
  provider: 'openai_basic',
  baseUrl: null,
  model: null,
  apiKey: null,
  language: null,
  args: null,
  timeoutMs: 5000,
  maxConcurrency: 1,
};

describe('ASR 块失败原因采样', () => {
  it('块失败计入 failedChunks 并保留异常 message 采样', async () => {
    const result = await transcribeWindow(
      'test/fixtures/media/case04_plain.mp4',
      [0, 1000],
      null,
      {
        ffmpegPath: 'definitely-missing-ffmpeg-binary-xyz',
        settings: SETTINGS,
        cacheDir: 'unused-cache-dir',
        cacheEnabled: false,
        sliceCodec: 'mp3',
      },
    );
    expect(result.failedChunks).toBeGreaterThan(0);
    expect(result.failureSamples.length).toBeGreaterThan(0);
  });

  it('全部块失败 → 覆盖承诺不生效，缓存不记覆盖区间（失败区间保持可重试）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-retry-'));
    const video = 'test/fixtures/media/case04_plain.mp4';
    try {
      const first = await transcribeWindow(video, [0, 1000], null, {
        ffmpegPath: 'definitely-missing-ffmpeg-binary-xyz',
        settings: SETTINGS,
        cacheDir: dir,
        cacheEnabled: true,
        sliceCodec: 'mp3',
      });
      expect(first.failedChunks).toBeGreaterThan(0);
      // 若覆盖承诺无条件执行，这里会写入 [0,1000] 覆盖区间 → 二次调用零请求
      // 提前返回（失败被永久掩盖）。正确语义：缓存不含覆盖区间，缺口可重试。
      const fp = `${await videoFingerprint(video)}-${engineFingerprint(SETTINGS)}`;
      const cached = await readTranscriptCache(dir, fp);
      expect(cached === null || cached.length === 0).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
