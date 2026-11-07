import { describe, expect, it } from 'vitest';
import {
  hostSpeechSupportsLanguage,
  probeHostSpeech,
  type HostSpeechService,
} from '../../../src/asr/hostSpeech.js';

function service(over: Partial<HostSpeechService> = {}): HostSpeechService {
  return {
    snapshot: () => ({
      providers: [
        {
          id: 'sensevoice-local',
          name: 'SenseVoiceSmall (INT8)',
          location: 'host-local',
          languages: ['auto', 'zh', 'en', 'ja'],
          preparation: { snapshot: () => ({ phase: 'ready' }) },
        },
      ],
    }),
    resolve: () => ({}),
    transcribe: async () => ({ text: 'hi' }),
    ...over,
  };
}

describe('probeHostSpeech', () => {
  it('没有服务 → available=false，原因可展示', () => {
    const facts = probeHostSpeech(undefined);
    expect(facts.available).toBe(false);
    expect(facts.ready).toBe(false);
    expect(facts.service).toBeNull();
    expect(facts.reason).toContain('未安装');
  });

  it('snapshot 抛错 → 服务存在但未就绪，不抛给调用方', () => {
    const facts = probeHostSpeech(
      service({
        snapshot: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(facts.available).toBe(true);
    expect(facts.ready).toBe(false);
    expect(facts.reason).toContain('不可读');
  });

  it('优先 sensevoice-local，而不是 snapshot.selection 指向的云端 provider', () => {
    const facts = probeHostSpeech(
      service({
        snapshot: () => ({
          selection: { providerId: 'openai-cloud', language: 'zh' },
          providers: [
            {
              id: 'openai-cloud',
              name: 'Cloud',
              location: 'cloud',
              languages: ['zh'],
              preparation: { snapshot: () => ({ phase: 'ready' }) },
            },
            {
              id: 'other-local',
              name: 'Other',
              location: 'host-local',
              languages: ['zh'],
              preparation: { snapshot: () => ({ phase: 'ready' }) },
            },
            {
              id: 'sensevoice-local',
              name: 'SenseVoiceSmall',
              location: 'host-local',
              languages: ['auto', 'zh'],
              preparation: { snapshot: () => ({ phase: 'standby' }) },
            },
          ],
        }),
      }),
    );
    expect(facts.providerId).toBe('sensevoice-local');
    expect(facts.ready).toBe(true);
    expect(facts.phase).toBe('standby');
  });

  it('没有 host-local provider → 未就绪', () => {
    const facts = probeHostSpeech(
      service({
        snapshot: () => ({
          providers: [{ id: 'cloud', location: 'cloud', languages: ['zh'] }],
        }),
      }),
    );
    expect(facts.available).toBe(true);
    expect(facts.ready).toBe(false);
    expect(facts.reason).toContain('没有本地');
  });

  it('同名 provider 标成 cloud 时也不选中，避免把音频发到云端', () => {
    const facts = probeHostSpeech(
      service({
        snapshot: () => ({
          providers: [
            {
              id: 'sensevoice-local',
              name: 'Cloud copy',
              location: 'cloud',
              languages: ['zh'],
              preparation: { snapshot: () => ({ phase: 'ready' }) },
            },
          ],
        }),
      }),
    );
    expect(facts.providerId).toBeNull();
    expect(facts.ready).toBe(false);
  });

  it('unprepared → 未就绪并提示下载准备', () => {
    const facts = probeHostSpeech(
      service({
        snapshot: () => ({
          providers: [
            {
              id: 'sensevoice-local',
              location: 'host-local',
              languages: ['zh'],
              preparation: { snapshot: () => ({ phase: 'unprepared' }) },
            },
          ],
        }),
      }),
    );
    expect(facts.ready).toBe(false);
    expect(facts.reason).toContain('未准备');
  });
});

describe('hostSpeechSupportsLanguage', () => {
  it('auto/null 总是支持', () => {
    expect(hostSpeechSupportsLanguage(['zh'], null)).toBe(true);
    expect(hostSpeechSupportsLanguage(['zh'], 'auto')).toBe(true);
  });

  it('接受 zh-CN 到 zh 的归一化', () => {
    expect(hostSpeechSupportsLanguage(['auto', 'zh'], 'zh-CN')).toBe(true);
  });

  it('不支持的语言返回 false', () => {
    expect(hostSpeechSupportsLanguage(['auto', 'zh'], 'ja')).toBe(false);
  });
});
