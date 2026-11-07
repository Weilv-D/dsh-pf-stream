import { describe, expect, it, vi } from 'vitest';
import { AsrRequestError, transcribeHostSpeech } from '../../../src/audio/asrProviders.js';
import type { AsrSettings } from '../../../src/audio/types.js';
import type { HostSpeechService } from '../../../src/asr/hostSpeech.js';

function settings(over: Partial<AsrSettings> = {}): AsrSettings {
  return {
    provider: 'host_sensevoice',
    baseUrl: null,
    model: 'sensevoice-local',
    apiKey: null,
    language: 'zh',
    args: null,
    timeoutMs: 120_000,
    maxConcurrency: 1,
    hostService: {
      snapshot: () => ({ providers: [] }),
      resolve: (request) => ({ request }),
      transcribe: async () => ({ text: '你好世界' }),
    },
    ...over,
  };
}

describe('transcribeHostSpeech', () => {
  it('调用官方 resolve/transcribe，并映射为块级单段', async () => {
    const resolve = vi.fn((request: { audio: Uint8Array; providerId?: string; language?: string }) => ({
      request,
    }));
    const transcribe = vi.fn(async () => ({ text: '  你好世界  ' }));
    const service: HostSpeechService = {
      snapshot: () => ({ providers: [] }),
      resolve,
      transcribe,
    };
    const input = {
      startMs: 1_000,
      endMs: 3_200,
      bytes: Buffer.from('RIFF....WAVE'),
      mimeType: 'audio/wav',
    };
    const out = await transcribeHostSpeech(input, { settings: settings({ hostService: service }) });
    expect(resolve).toHaveBeenCalledWith({
      audio: input.bytes,
      providerId: 'sensevoice-local',
      language: 'zh',
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(out).toEqual([{ startMs: 0, endMs: 2_200, text: '你好世界' }]);
  });

  it('空文本返回空段', async () => {
    const service: HostSpeechService = {
      snapshot: () => ({ providers: [] }),
      resolve: () => ({}),
      transcribe: async () => ({ text: '   ' }),
    };
    const out = await transcribeHostSpeech(
      { startMs: 0, endMs: 1_000, bytes: Buffer.from('RIFF'), mimeType: 'audio/wav' },
      { settings: settings({ hostService: service }) },
    );
    expect(out).toEqual([]);
  });

  it('服务缺失 → AsrRequestError(ASR_HOST_UNAVAILABLE)', async () => {
    await expect(
      transcribeHostSpeech(
        { startMs: 0, endMs: 1_000, bytes: Buffer.from('RIFF'), mimeType: 'audio/wav' },
        { settings: settings({ hostService: null }) },
      ),
    ).rejects.toMatchObject({ code: 'ASR_HOST_UNAVAILABLE' });
  });

  it('官方 transcribe 抛错 → 包成 AsrRequestError(ASR_HOST_TRANSCRIBE)', async () => {
    const service: HostSpeechService = {
      snapshot: () => ({ providers: [] }),
      resolve: () => ({}),
      transcribe: async () => {
        throw new Error('worker exploded');
      },
    };
    const error = await transcribeHostSpeech(
      { startMs: 0, endMs: 1_000, bytes: Buffer.from('RIFF'), mimeType: 'audio/wav' },
      { settings: settings({ hostService: service }) },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AsrRequestError);
    expect((error as AsrRequestError).code).toBe('ASR_HOST_TRANSCRIBE');
  });

  it('官方 transcribe 超时 → AsrRequestError(ASR_TIMEOUT)，不等待 provider 自行结束', async () => {
    const service: HostSpeechService = {
      snapshot: () => ({ providers: [] }),
      resolve: () => ({}),
      transcribe: () => new Promise(() => {}),
    };
    const error = await transcribeHostSpeech(
      { startMs: 0, endMs: 1_000, bytes: Buffer.from('RIFF'), mimeType: 'audio/wav' },
      { settings: settings({ hostService: service, timeoutMs: 20 }) },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AsrRequestError);
    expect((error as AsrRequestError).code).toBe('ASR_TIMEOUT');
  });

  it('空白语言不传给官方 resolve', async () => {
    const resolve = vi.fn(() => ({}));
    const service: HostSpeechService = {
      snapshot: () => ({ providers: [] }),
      resolve,
      transcribe: async () => ({ text: 'hi' }),
    };
    await transcribeHostSpeech(
      { startMs: 0, endMs: 1_000, bytes: Buffer.from('RIFF'), mimeType: 'audio/wav' },
      { settings: settings({ hostService: service, language: '   ' }) },
    );
    expect(resolve).toHaveBeenCalledWith({
      audio: Buffer.from('RIFF'),
      providerId: 'sensevoice-local',
    });
  });

  it('外部取消 → AsrRequestError(ASR_ABORT)，不误报为转写失败', async () => {
    const controller = new AbortController();
    controller.abort();
    const service: HostSpeechService = {
      snapshot: () => ({ providers: [] }),
      resolve: () => ({}),
      transcribe: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    };
    const error = await transcribeHostSpeech(
      { startMs: 0, endMs: 1_000, bytes: Buffer.from('RIFF'), mimeType: 'audio/wav' },
      { settings: settings({ hostService: service }), signal: controller.signal },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AsrRequestError);
    expect((error as AsrRequestError).code).toBe('ASR_ABORT');
  });

  it('官方返回 null → AsrRequestError(ASR_HOST_TRANSCRIBE)，不抛裸 TypeError', async () => {
    const service: HostSpeechService = {
      snapshot: () => ({ providers: [] }),
      resolve: () => ({}),
      transcribe: async () => null as unknown as { text: string },
    };
    const error = await transcribeHostSpeech(
      { startMs: 0, endMs: 1_000, bytes: Buffer.from('RIFF'), mimeType: 'audio/wav' },
      { settings: settings({ hostService: service }) },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AsrRequestError);
    expect((error as AsrRequestError).code).toBe('ASR_HOST_TRANSCRIBE');
  });
});
