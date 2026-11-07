import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveAsr, type AsrConfigSlice, type AsrRuntimeFacts } from '../../../src/asr/engine.js';
import type { LocalEngineSnapshot } from '../../../src/asr/detect.js';
import type { HostSpeechFacts, HostSpeechService } from '../../../src/asr/hostSpeech.js';

const LOCAL_READY: LocalEngineSnapshot = {
  engine: 'managed',
  exe: path.join('C:', 'cache', 'whisper-cli.exe'),
  source: 'managed',
  modelPath: path.join('C:', 'cache', 'ggml-small-q5_1.bin'),
  modelId: 'small-q5_1',
  ready: true,
  reason: null,
};

const LOCAL_MISSING: LocalEngineSnapshot = {
  engine: 'managed',
  exe: null,
  source: 'managed',
  modelPath: null,
  modelId: 'small-q5_1',
  ready: false,
  reason: '尚未安装本地转写引擎',
};

const HOST_SERVICE: HostSpeechService = {
  snapshot: () => ({ providers: [] }),
  resolve: () => ({}),
  transcribe: async () => ({ text: '' }),
};

function hostFacts(over: Partial<HostSpeechFacts> = {}): HostSpeechFacts {
  return {
    available: true,
    ready: true,
    providerId: 'sensevoice-local',
    providerName: 'SenseVoiceSmall',
    phase: 'ready',
    languages: ['auto', 'zh', 'en'],
    reason: null,
    service: HOST_SERVICE,
    ...over,
  };
}

function slice(over: Partial<AsrConfigSlice> = {}): AsrConfigSlice {
  return {
    engine: 'auto',
    preset: 'openai',
    provider: 'none',
    timeoutMs: 8000,
    maxConcurrency: 2,
    ...over,
  };
}

function facts(over: Partial<AsrRuntimeFacts> = {}): AsrRuntimeFacts {
  return {
    detection: LOCAL_READY,
    keys: {},
    localTimeoutMs: 300000,
    ...over,
  };
}

const NO_ENV: NodeJS.ProcessEnv = {};

describe('引擎选择 resolveAsr', () => {
  it('auto + 已配置密钥 → 云端，协议与端点来自预设', () => {
    const out = resolveAsr(slice(), undefined, NO_ENV, facts({ keys: { openai: 'sk-test' } }));
    expect(out.kind).toBe('cloud');
    expect(out.settings?.provider).toBe('openai_verbose');
    expect(out.settings?.baseUrl).toBe('https://api.openai.com');
    expect(out.settings?.model).toBe('whisper-1');
    expect(out.settings?.apiKey).toBe('sk-test');
    expect(out.reason).toBeNull();
  });

  it('auto + 无密钥 + 本地就绪 → 本地，参数内置且带 {outbase}', () => {
    const out = resolveAsr(slice(), 'zh', NO_ENV, facts());
    expect(out.kind).toBe('local');
    expect(out.settings?.provider).toBe('local_cli');
    expect(out.settings?.model).toBe(LOCAL_READY.exe);
    expect(out.settings?.args).toEqual([
      '-m',
      LOCAL_READY.modelPath,
      '-f',
      '{audio}',
      '-osrt',
      '-of',
      '{outbase}',
      '-l',
      'zh',
      '-t',
      '4',
    ]);
    expect(out.settings?.timeoutMs).toBe(300000);
    expect(out.settings?.maxConcurrency).toBe(1);
  });

  it('auto + 云端优先：有密钥时即使本地就绪也走云端', () => {
    const out = resolveAsr(slice(), undefined, NO_ENV, facts({ keys: { openai: 'sk-test' } }));
    expect(out.kind).toBe('cloud');
  });

  it('本地未安装 → null 且原因可展示', () => {
    const out = resolveAsr(slice(), undefined, NO_ENV, facts({ detection: LOCAL_MISSING }));
    expect(out.settings).toBeNull();
    expect(out.kind).toBe('none');
    expect(out.reason).toBe('local_missing_engine');
    expect(out.detail).toBe('尚未安装本地转写引擎');
  });

  it('engine=off 关闭转写', () => {
    const out = resolveAsr(slice({ engine: 'off' }), undefined, NO_ENV, facts());
    expect(out.settings).toBeNull();
    expect(out.reason).toBe('engine_off');
  });

  it('engine=cloud 缺密钥 → cloud_missing_key（不回退本地）', () => {
    const out = resolveAsr(slice({ engine: 'cloud' }), undefined, NO_ENV, facts());
    expect(out.settings).toBeNull();
    expect(out.reason).toBe('cloud_missing_key');
  });

  it('自定义预设缺端点 → cloud_missing_endpoint', () => {
    const out = resolveAsr(
      slice({ engine: 'cloud', preset: 'custom', baseUrl: '', model: '' }),
      undefined,
      NO_ENV,
      facts({ keys: { custom: 'sk-x' } }),
    );
    expect(out.settings).toBeNull();
    expect(out.reason).toBe('cloud_missing_endpoint');
  });

  it('自定义预设齐全时用用户端点，并去掉尾斜杠', () => {
    const out = resolveAsr(
      slice({ engine: 'cloud', preset: 'custom', baseUrl: 'https://example.com/v1/', model: 'whisper-x' }),
      undefined,
      NO_ENV,
      facts({ keys: { custom: 'sk-x' } }),
    );
    expect(out.kind).toBe('cloud');
    expect(out.settings?.baseUrl).toBe('https://example.com/v1');
    expect(out.settings?.model).toBe('whisper-x');
  });

  it('环境变量密钥优先于存储密钥', () => {
    const out = resolveAsr(slice(), undefined, { DSH_ASR_API_KEY: 'sk-env' }, facts({ keys: { openai: 'sk-store' } }));
    expect(out.settings?.apiKey).toBe('sk-env');
  });

  it('旧 provider 显式配置优先于 auto（0.2.x 兼容）', () => {
    const out = resolveAsr(
      slice({ provider: 'openai_basic', apiKey: 'sk-legacy', baseUrl: 'https://legacy.example.com' }),
      undefined,
      NO_ENV,
      facts(),
    );
    expect(out.kind).toBe('cloud');
    expect(out.settings?.provider).toBe('openai_basic');
    expect(out.settings?.apiKey).toBe('sk-legacy');
  });

  it('旧 provider 缺密钥 → cloud_missing_key', () => {
    const out = resolveAsr(slice({ provider: 'openai_verbose' }), undefined, NO_ENV, facts());
    expect(out.settings).toBeNull();
    expect(out.reason).toBe('cloud_missing_key');
  });

  it('没有运行时事实时保持 0.2.x 语义（provider=none → 无）', () => {
    const out = resolveAsr(slice({ provider: 'none' }), undefined, NO_ENV, undefined);
    expect(out.settings).toBeNull();
    expect(out.kind).toBe('none');
  });

  it('auto + 无云端密钥 + host 就绪 → 复用 host，且优先于 whisper 本地', () => {
    const out = resolveAsr(slice(), 'zh', NO_ENV, facts({ hostSpeech: hostFacts() }));
    expect(out.kind).toBe('host');
    expect(out.settings?.provider).toBe('host_sensevoice');
    expect(out.settings?.model).toBe('sensevoice-local');
    expect(out.settings?.maxConcurrency).toBe(1);
    expect(out.settings?.hostService).toBe(HOST_SERVICE);
  });

  it('auto + 云端密钥 + host 就绪 → 云端优先，保持现有行为', () => {
    const out = resolveAsr(
      slice(),
      undefined,
      NO_ENV,
      facts({ keys: { openai: 'sk-test' }, hostSpeech: hostFacts() }),
    );
    expect(out.kind).toBe('cloud');
  });

  it('engine=local + host 就绪 → host 优先；host 未就绪则回退 whisper', () => {
    const host = resolveAsr(slice({ engine: 'local' }), undefined, NO_ENV, facts({ hostSpeech: hostFacts() }));
    expect(host.kind).toBe('host');

    const fallback = resolveAsr(
      slice({ engine: 'local' }),
      undefined,
      NO_ENV,
      facts({ hostSpeech: hostFacts({ ready: false, phase: 'unprepared', reason: '模型未准备' }) }),
    );
    expect(fallback.kind).toBe('local');
  });

  it('engine=host 未就绪 → 不静默回退，给出 host_not_ready', () => {
    const out = resolveAsr(
      slice({ engine: 'host' }),
      undefined,
      NO_ENV,
      facts({ hostSpeech: hostFacts({ ready: false, phase: 'unprepared', reason: '模型未准备' }) }),
    );
    expect(out.settings).toBeNull();
    expect(out.kind).toBe('none');
    expect(out.reason).toBe('host_not_ready');
    expect(out.detail).toBe('模型未准备');
  });

  it('engine=host + 不支持的语言 → host_language_unsupported', () => {
    const out = resolveAsr(
      slice({ engine: 'host' }),
      'ja',
      NO_ENV,
      facts({ hostSpeech: hostFacts({ languages: ['auto', 'zh', 'en'] }) }),
    );
    expect(out.settings).toBeNull();
    expect(out.reason).toBe('host_language_unsupported');
  });

  it('engine=host 没有该服务 → host_missing_service', () => {
    const out = resolveAsr(slice({ engine: 'host' }), undefined, NO_ENV, facts());
    expect(out.settings).toBeNull();
    expect(out.reason).toBe('host_missing_service');
  });

  it('host 把 zh-CN 归一化为 provider 的精确语言 zh', () => {
    const out = resolveAsr(slice({ engine: 'host' }), 'zh-CN', NO_ENV, facts({ hostSpeech: hostFacts() }));
    expect(out.kind).toBe('host');
    expect(out.settings?.language).toBe('zh');
  });

  it('host 首选不支持当前语言时，按语言选另一个就绪 provider', () => {
    const service: HostSpeechService = {
      snapshot: () => ({
        providers: [
          {
            id: 'sensevoice-local',
            name: 'English only',
            location: 'host-local',
            languages: ['en'],
            preparation: { snapshot: () => ({ phase: 'ready' }) },
          },
          {
            id: 'other-local',
            name: 'Chinese ready',
            location: 'host-local',
            languages: ['zh'],
            preparation: { snapshot: () => ({ phase: 'ready' }) },
          },
        ],
      }),
      resolve: () => ({}),
      transcribe: async () => ({ text: '' }),
    };
    const out = resolveAsr(
      slice({ engine: 'host' }),
      'zh',
      NO_ENV,
      facts({
        hostSpeech: hostFacts({
          providerId: 'sensevoice-local',
          providerName: 'English only',
          languages: ['en'],
          service,
        }),
      }),
    );
    expect(out.kind).toBe('host');
    expect(out.settings?.model).toBe('other-local');
    expect(out.settings?.language).toBe('zh');
  });

  it('host 把空白语言当作省略，不把空串传给官方 resolve', () => {
    const out = resolveAsr(slice({ engine: 'host' }), '   ', NO_ENV, facts({ hostSpeech: hostFacts() }));
    expect(out.kind).toBe('host');
    expect(out.settings?.language).toBeNull();
  });

  it('auto 的 host 未就绪且本地也缺失时，原因指向 host 而不是 local_missing_engine', () => {
    const out = resolveAsr(
      slice(),
      undefined,
      NO_ENV,
      facts({
        detection: LOCAL_MISSING,
        hostSpeech: hostFacts({ ready: false, phase: 'unprepared', reason: '模型未准备' }),
      }),
    );
    expect(out.settings).toBeNull();
    expect(out.reason).toBe('host_not_ready');
    expect(out.detail).toContain('模型未准备');
    expect(out.detail).toContain('尚未安装本地转写引擎');
  });

  it('host 声称 ready 但 providerId 缺失时，不返回 host 设置', () => {
    const out = resolveAsr(
      slice({ engine: 'host' }),
      undefined,
      NO_ENV,
      facts({ hostSpeech: hostFacts({ providerId: null }) }),
    );
    expect(out.settings).toBeNull();
    expect(out.reason).toBe('host_not_ready');
  });
});
