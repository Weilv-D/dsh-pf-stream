import { describe, expect, it } from 'vitest';
import { HostRuntime, type ConfigEntry } from '../../../src/host/runtime.js';
import type { HostSpeechService } from '../../../src/asr/hostSpeech.js';
import type { PfStreamPluginConfig } from '../../../src/types.js';

const BASE_CONFIG = {
  audio: { mode: 'auto', asr: { engine: 'auto', preset: 'openai' } },
  renderVisualId: true,
  maxPacketsPerCall: 64,
} as unknown as PfStreamPluginConfig;

function entry(config: Record<string, unknown> = BASE_CONFIG as unknown as Record<string, unknown>): ConfigEntry {
  return { options: { id: 'include:dsh-pf-stream', name: 'dsh-pf-stream', config } };
}

function makeRuntime(options: {
  entries?: ConfigEntry[];
  edit?: (entry: ConfigEntry, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => Promise<void>;
}): HostRuntime {
  return new HostRuntime(() => BASE_CONFIG, {
    configEditor: {
      entries: () => options.entries ?? [entry()],
      edit:
        options.edit ??
        (async () => {
          return undefined;
        }),
    },
  });
}

describe('配置写入（走 configEditor）', () => {
  it('能定位到本插件的 profile 条目', () => {
    const runtime = makeRuntime({});
    expect(runtime.resolveConfigNamespace()).toBe('include:dsh-pf-stream');
  });

  it('深合并只覆盖改动的叶子，其余配置保留', async () => {
    let derived: Record<string, unknown> | null = null;
    const runtime = makeRuntime({
      edit: async (_entry, change) => {
        derived = change(entry().options.config ?? {}, {});
      },
    });
    const result = await runtime.patchConfig({ audio: { asr: { engine: 'cloud' } } });
    expect(result.ok).toBe(true);
    expect(derived).toEqual({
      audio: { mode: 'auto', asr: { engine: 'cloud', preset: 'openai' } },
      renderVisualId: true,
      maxPacketsPerCall: 64,
    });
  });

  it('数组字段整体替换，不按索引合并', async () => {
    let derived: Record<string, unknown> | null = null;
    const runtime = makeRuntime({
      entries: [entry({ audio: { asr: { args: ['a', 'b'] } } })],
      edit: async (_entry, change) => {
        derived = change({ audio: { asr: { args: ['a', 'b'] } } }, {});
      },
    });
    await runtime.patchConfig({ audio: { asr: { args: ['x'] } } });
    expect((derived as unknown as { audio: { asr: { args: string[] } } }).audio.asr.args).toEqual(['x']);
  });

  it('条目 id 前缀变化时仍能按包名定位（link 安装 / 改名场景）', () => {
    const runtime = makeRuntime({
      entries: [{ options: { id: 'plugin:dsh-pf-stream@0.3.0', name: 'dsh-pf-stream (link)', config: {} } }],
    });
    expect(runtime.resolveConfigNamespace()).toBe('plugin:dsh-pf-stream@0.3.0');
  });

  it('宿主没有 configEditor 时返回可读失败原因，而不是抛错', async () => {
    const runtime = new HostRuntime(() => BASE_CONFIG, {});
    expect(runtime.resolveConfigNamespace()).toBeNull();
    const result = await runtime.patchConfig({ audio: { asr: { engine: 'off' } } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('cordis.patch.yml');
  });

  it('写入失败时把宿主错误原样带回', async () => {
    const runtime = makeRuntime({
      edit: async () => {
        throw new Error('Configuration entry is no longer available');
      },
    });
    const result = await runtime.patchConfig({ audio: { asr: { engine: 'off' } } });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('no longer available');
  });

  it('保存后当前实例立即读到新值（面板回显不再清空）', async () => {
    const runtime = makeRuntime({});
    await runtime.patchConfig({
      audio: { asr: { preset: 'custom', baseUrl: 'https://api.example.com/v1/audio/transcriptions', model: 'm' } },
    });
    const config = runtime.currentConfig() as unknown as {
      audio: { asr: { preset: string; baseUrl: string; model: string; engine: string } };
    };
    expect(config.audio.asr.preset).toBe('custom');
    expect(config.audio.asr.baseUrl).toBe('https://api.example.com/v1/audio/transcriptions');
    expect(config.audio.asr.model).toBe('m');
    expect(config.audio.asr.engine).toBe('auto');
  });
});

function hostService(phase: string): HostSpeechService {
  return {
    snapshot: () => ({
      providers: [
        {
          id: 'sensevoice-local',
          name: 'SenseVoiceSmall',
          location: 'host-local',
          languages: ['auto', 'zh', 'en'],
          preparation: { snapshot: () => ({ phase }) },
        },
      ],
    }),
    resolve: () => ({}),
    transcribe: async () => ({ text: 'ok' }),
  };
}

function hostConfig(): PfStreamPluginConfig {
  return {
    ...BASE_CONFIG,
    audio: {
      ...BASE_CONFIG.audio,
      cacheDir: 'C:/tmp/dsh-pf-stream-test-cache',
      asr: { ...BASE_CONFIG.audio.asr, engine: 'host' },
    },
  } as PfStreamPluginConfig;
}

describe('host 引擎状态', () => {
  it('官方 provider ready 时 ready=true，active.kind=host', async () => {
    const runtime = new HostRuntime(() => hostConfig(), { speechToText: hostService('ready') });
    const status = await runtime.status();
    expect(status.ready).toBe(true);
    expect(status.host.ready).toBe(true);
    expect(status.host.providerId).toBe('sensevoice-local');
    expect(status.active.kind).toBe('host');
    expect(status.summary).toContain('官方语音输入');
  });

  it('provider 未准备时给出原因，不把 ready 置真', async () => {
    const runtime = new HostRuntime(() => hostConfig(), { speechToText: hostService('unprepared') });
    const status = await runtime.status();
    expect(status.ready).toBe(false);
    expect(status.host.ready).toBe(false);
    expect(status.active.kind).toBe('none');
    expect(status.summary).toContain('未准备');
  });

  it('没有 speechToText 服务时 host.available=false', async () => {
    const runtime = new HostRuntime(() => hostConfig(), {});
    const status = await runtime.status();
    expect(status.host.available).toBe(false);
    expect(status.ready).toBe(false);
  });
});
