import { describe, expect, it } from 'vitest';
import {
  probeHostSpeech,
  resolveHostSpeechLanguage,
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

  it('首选未准备、另一个 host provider 已就绪 → 选已就绪者', () => {
    const facts = probeHostSpeech(
      service({
        snapshot: () => ({
          providers: [
            {
              id: 'sensevoice-local',
              name: 'SenseVoiceSmall',
              location: 'host-local',
              languages: ['zh'],
              preparation: { snapshot: () => ({ phase: 'unprepared' }) },
            },
            {
              id: 'other-local',
              name: 'Other',
              location: 'host-local',
              languages: ['zh'],
              preparation: { snapshot: () => ({ phase: 'ready' }) },
            },
          ],
        }),
      }),
    );
    expect(facts.providerId).toBe('other-local');
    expect(facts.ready).toBe(true);
  });

  it('官方 selection 指向 host-local 就绪 provider 时尊重该选择', () => {
    const facts = probeHostSpeech(
      service({
        snapshot: () => ({
          selection: { providerId: 'other-local' },
          providers: [
            {
              id: 'sensevoice-local',
              name: 'SenseVoiceSmall',
              location: 'host-local',
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
          ],
        }),
      }),
    );
    expect(facts.providerId).toBe('other-local');
    expect(facts.ready).toBe(true);
  });

  it('有目标语言时选「就绪且支持语言」的 provider，而不是仅首选', () => {
    const facts = probeHostSpeech(
      service({
        snapshot: () => ({
          providers: [
            {
              id: 'sensevoice-local',
              name: 'SenseVoiceSmall',
              location: 'host-local',
              languages: ['en'],
              preparation: { snapshot: () => ({ phase: 'ready' }) },
            },
            {
              id: 'other-local',
              name: 'Other',
              location: 'host-local',
              languages: ['zh'],
              preparation: { snapshot: () => ({ phase: 'ready' }) },
            },
          ],
        }),
      }),
      'sensevoice-local',
      'zh-CN',
    );
    expect(facts.providerId).toBe('other-local');
    expect(facts.ready).toBe(true);
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

  it('同一 id 同时存在 host-local 与 cloud provider → 拒绝歧义', () => {
    const facts = probeHostSpeech(
      service({
        snapshot: () => ({
          providers: [
            {
              id: 'sensevoice-local',
              name: 'Local',
              location: 'host-local',
              languages: ['zh'],
              preparation: { snapshot: () => ({ phase: 'ready' }) },
            },
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
    expect(facts.reason).toContain('id 重复');
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

  it('host-local provider 缺少 id 且存在同名 cloud provider → 拒绝选中', () => {
    const facts = probeHostSpeech(
      service({
        snapshot: () => ({
          providers: [
            {
              name: 'No id local',
              location: 'host-local',
              languages: ['zh'],
              preparation: { snapshot: () => ({ phase: 'ready' }) },
            },
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
    expect(facts.reason).toContain('缺少 id');
  });
});

describe('语言支持判定（resolveHostSpeechLanguage.supported）', () => {
  it('auto/null 总是支持', () => {
    expect(resolveHostSpeechLanguage(['zh'], null).supported).toBe(true);
    expect(resolveHostSpeechLanguage(['zh'], 'auto').supported).toBe(true);
  });

  it('接受 zh-CN 到 zh 的归一化', () => {
    expect(resolveHostSpeechLanguage(['auto', 'zh'], 'zh-CN').supported).toBe(true);
  });

  it('不支持的语言返回 false', () => {
    expect(resolveHostSpeechLanguage(['auto', 'zh'], 'ja').supported).toBe(false);
  });
});

describe('resolveHostSpeechLanguage', () => {
  it('返回 provider 列表中的精确值，而不是请求里的地区标签', () => {
    expect(resolveHostSpeechLanguage(['auto', 'zh', 'en'], 'zh-CN')).toEqual({
      supported: true,
      language: 'zh',
    });
    expect(resolveHostSpeechLanguage(['zh-CN'], 'zh-cn')).toEqual({
      supported: true,
      language: 'zh-CN',
    });
  });

  it('空白语言返回 null，让官方使用默认值', () => {
    expect(resolveHostSpeechLanguage(['auto', 'zh'], '   ')).toEqual({
      supported: true,
      language: null,
    });
  });

  it('auto 返回 provider 的 auto 原值；不支持时返回 false', () => {
    expect(resolveHostSpeechLanguage(['auto', 'zh'], 'auto')).toEqual({
      supported: true,
      language: 'auto',
    });
    expect(resolveHostSpeechLanguage(['auto', 'zh'], 'ko')).toEqual({
      supported: false,
      language: null,
    });
  });
});
