/**
 * ASR 块失败零诊断缺口修复的回归：失败原因采样（≤5 条）随 AsrRunResult
 * 透出，并经 sidecar 注入 audio.telemetry.failureSamples（工具返回根级可
 * 见）。用坏 ffmpegPath 触发 sliceAudio spawn 失败，不触网。
 */

import { describe, expect, it } from 'vitest';
import { transcribeWindow } from '../../../src/audio/asrRouter.js';
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
});
