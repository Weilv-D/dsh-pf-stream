/**
 * host_sensevoice 走真实切块/锚定路径：段必须可无损 JSON 化（无 undefined 字段），
 * 否则宿主会以 "value is not lossless JSON" 拒绝整条工具结果。
 */

import { describe, expect, it } from 'vitest';
import { transcribeWindow } from '../../../src/audio/asrRouter.js';
import type { AsrSettings } from '../../../src/audio/types.js';
import type { HostSpeechService } from '../../../src/asr/hostSpeech.js';

const hostService: HostSpeechService = {
  snapshot: () => ({ providers: [] }),
  resolve: () => ({}),
  transcribe: async () => ({ text: '测试语音', audioSeconds: 2, inferenceSeconds: 0.1 }),
};

const SETTINGS: AsrSettings = {
  provider: 'host_sensevoice',
  baseUrl: null,
  model: 'sensevoice-local',
  apiKey: null,
  language: 'zh',
  args: null,
  timeoutMs: 5000,
  maxConcurrency: 1,
  hostService,
};

describe('host_sensevoice 段投影', () => {
  it('锚定后的段没有 undefined 字段，JSON 往返严格相等', async () => {
    const result = await transcribeWindow(
      'test/fixtures/media/case_audio_silence.mp4',
      [0, 2000],
      null,
      {
        ffmpegPath: 'ffmpeg',
        settings: SETTINGS,
        cacheDir: 'unused-cache-dir',
        cacheEnabled: false,
        sliceCodec: 'wav',
      },
    );
    expect(result.failedChunks).toBe(0);
    expect(result.segments.length).toBeGreaterThan(0);
    for (const segment of result.segments) {
      expect(segment.startMs).toBeTypeOf('number');
      expect(segment.endMs).toBeTypeOf('number');
      expect(Number.isFinite(segment.startMs)).toBe(true);
      expect(Number.isFinite(segment.endMs)).toBe(true);
      expect(JSON.parse(JSON.stringify(segment))).toStrictEqual(segment);
    }
  }, 60_000);
});
