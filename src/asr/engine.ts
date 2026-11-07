/**
 * 引擎选择：把「用户意图（engine/preset）」+「机器事实（探测结果/密钥）」
 * 解析成一次转写要用的 AsrSettings。
 *
 * 默认 engine='auto' 的语义：
 * 1. 用户显式配了旧版 provider → 尊重旧配置（0.2.x 行为不变）；
 * 2. 有云端密钥 → 云端（便宜、快、免下载）；
 * 3. 官方语音输入模型就绪 → 复用它；
 * 4. 本机有可用本地引擎 → 本地；
 * 5. 都没有 → null，并给出「为什么没有」的原因供结果提示与设置页展示。
 */

import type { AsrSettings } from '../audio/types.js';
import { buildLocalArgs, cloudPreset, LOCAL_ENGINES, modelPreset } from './catalog.js';
import type { LocalEngineSnapshot } from './detect.js';
import { resolveHostSpeechLanguage, type HostSpeechFacts } from './hostSpeech.js';

export type AsrEngineMode = 'auto' | 'local' | 'cloud' | 'host' | 'off' | 'legacy';

export type AsrUnavailableReason =
  | 'engine_off'
  | 'cloud_missing_key'
  | 'cloud_missing_endpoint'
  | 'local_missing_engine'
  | 'local_missing_model'
  | 'host_missing_service'
  | 'host_not_ready'
  | 'host_language_unsupported';

export interface AsrRuntimeFacts {
  detection: LocalEngineSnapshot;
  /** 按云端预设 id 存放的密钥；null/缺省表示未配置。 */
  keys: Readonly<Record<string, string | null>>;
  /** 本地推理单请求超时（毫秒）；CPU 上远大于云端。 */
  localTimeoutMs: number;
  /** 本地推理线程数；0 表示交给引擎决定（内部按 4 处理）。 */
  localThreads?: number | undefined;
  /** 官方「语音输入」插件的本地 provider；缺省表示宿主未提供该服务。 */
  hostSpeech?: HostSpeechFacts | undefined;
}

export interface AsrConfigSlice {
  engine?: string | undefined;
  preset?: string | undefined;
  provider: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  apiKey?: string | undefined;
  language?: string | undefined;
  args?: string[] | undefined;
  timeoutMs: number;
  maxConcurrency: number;
}

export interface AsrResolution {
  settings: AsrSettings | null;
  kind: 'cloud' | 'local' | 'host' | 'legacy' | 'none';
  reason: AsrUnavailableReason | null;
  /** 面向用户的一句话解释（设置页与结果提示共用）。 */
  detail: string | null;
}

function legacySettings(config: AsrConfigSlice, language: string | null, apiKey: string | null): AsrSettings {
  return {
    provider: config.provider as AsrSettings['provider'],
    baseUrl: config.baseUrl?.trim() || null,
    model: config.model?.trim() || null,
    apiKey,
    language,
    args: config.args !== undefined && config.args.length > 0 ? config.args : null,
    timeoutMs: config.timeoutMs,
    maxConcurrency: config.maxConcurrency,
  };
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hostSettings(
  config: AsrConfigSlice,
  language: string | null,
  host: HostSpeechFacts | undefined,
): AsrSettings | null {
  if (
    host === undefined ||
    !host.available ||
    !host.ready ||
    host.service === null ||
    host.providerId === null
  ) {
    return null;
  }
  const choice = resolveHostSpeechLanguage(host.languages, language);
  if (!choice.supported) return null;
  return {
    provider: 'host_sensevoice',
    baseUrl: null,
    model: host.providerId,
    modelLabel: host.providerName,
    apiKey: null,
    language: choice.language,
    args: null,
    // 官方推理超时默认 120s；工具侧 grace 仍按 audio.graceMs 控制等待。
    timeoutMs: Math.max(config.timeoutMs, 120_000),
    maxConcurrency: 1,
    hostService: host.service,
  };
}

function hostUnavailable(
  language: string | null,
  host: HostSpeechFacts | undefined,
): { reason: AsrUnavailableReason; detail: string } {
  if (host === undefined || !host.available) {
    return {
      reason: 'host_missing_service',
      detail: host?.reason ?? '未安装或未启用官方语音输入插件',
    };
  }
  if (!host.ready) {
    return { reason: 'host_not_ready', detail: host.reason ?? '官方语音输入插件模型未准备' };
  }
  if (host.service === null || host.providerId === null) {
    return { reason: 'host_not_ready', detail: '官方语音输入提供方当前不可用' };
  }
  if (!resolveHostSpeechLanguage(host.languages, language).supported) {
    return {
      reason: 'host_language_unsupported',
      detail: `官方语音输入插件不支持语言 ${language ?? 'auto'}`,
    };
  }
  return { reason: 'host_not_ready', detail: '官方语音输入提供方当前不可用' };
}

export function resolveAsr(
  config: AsrConfigSlice,
  intentLanguage: string | undefined,
  env: NodeJS.ProcessEnv,
  facts: AsrRuntimeFacts | undefined,
): AsrResolution {
  const intent = intentLanguage?.trim();
  const language = intent !== undefined && intent !== '' ? intent : config.language?.trim() || null;
  const envKey = env.DSH_ASR_API_KEY?.trim();

  // 没有运行时事实（单元测试 / 宿主未注入）时退回 0.2.x 语义。
  if (facts === undefined) {
    if (config.engine === 'host') {
      return {
        settings: null,
        kind: 'none',
        reason: 'host_missing_service',
        detail: '当前宿主没有提供官方语音输入服务',
      };
    }
    const provider = config.provider;
    const needsKey = provider === 'openai_verbose' || provider === 'openai_basic';
    const apiKey = hasText(envKey) ? envKey : config.apiKey?.trim() || null;
    if (provider === 'none' || (needsKey && !hasText(apiKey))) {
      return { settings: null, kind: 'none', reason: 'cloud_missing_key', detail: null };
    }
    return {
      settings: legacySettings(config, language, apiKey),
      kind: provider === 'local_cli' ? 'local' : 'cloud',
      reason: null,
      detail: null,
    };
  }

  const mode = (config.engine ?? 'auto') as AsrEngineMode;

  if (mode === 'off') {
    return { settings: null, kind: 'none', reason: 'engine_off', detail: '转写已关闭' };
  }

  const preset = cloudPreset(config.preset ?? null);
  const presetKey = facts.keys[preset.id] ?? null;
  const cloudKey = hasText(envKey) ? envKey : presetKey;
  const baseUrl = preset.editable ? config.baseUrl?.trim() ?? '' : preset.baseUrl;
  const model = preset.editable ? config.model?.trim() ?? '' : preset.model;
  const cloudReady = hasText(cloudKey) && hasText(baseUrl) && hasText(model);

  const legacyExplicit =
    config.provider !== 'none' && mode !== 'cloud' && mode !== 'local' && mode !== 'host';

  if (mode === 'legacy' || legacyExplicit) {
    const needsKey = config.provider === 'openai_verbose' || config.provider === 'openai_basic';
    const apiKey = hasText(envKey) ? envKey : config.apiKey?.trim() || null;
    if (config.provider === 'none') {
      return { settings: null, kind: 'none', reason: 'engine_off', detail: '尚未选择转写引擎' };
    }
    if (needsKey && !hasText(apiKey)) {
      return { settings: null, kind: 'none', reason: 'cloud_missing_key', detail: '缺少云端密钥' };
    }
    return {
      settings: legacySettings(config, language, apiKey),
      kind: config.provider === 'local_cli' ? 'local' : 'cloud',
      reason: null,
      detail: null,
    };
  }

  const wantCloud = mode === 'cloud' || (mode === 'auto' && cloudReady);
  if (wantCloud) {
    if (!hasText(baseUrl)) {
      return {
        settings: null,
        kind: 'none',
        reason: 'cloud_missing_endpoint',
        detail: '自定义端点需要填写 baseUrl',
      };
    }
    if (!hasText(cloudKey)) {
      return { settings: null, kind: 'none', reason: 'cloud_missing_key', detail: '尚未配置云端密钥' };
    }
    if (!hasText(model)) {
      return { settings: null, kind: 'none', reason: 'cloud_missing_endpoint', detail: '尚未选择转写模型' };
    }
    return {
      settings: {
        provider: preset.protocol,
        baseUrl: baseUrl.replace(/\/+$/, ''),
        model,
        apiKey: cloudKey,
        language,
        args: null,
        timeoutMs: config.timeoutMs,
        maxConcurrency: config.maxConcurrency,
      },
      kind: 'cloud',
      reason: null,
      detail: null,
    };
  }

  const host = facts.hostSpeech;
  const wantHost = mode === 'host' || mode === 'local' || mode === 'auto';
  if (wantHost) {
    const settings = hostSettings(config, language, host);
    if (settings !== null) {
      return {
        settings,
        kind: 'host',
        reason: null,
        detail:
          host?.providerName === null || host?.providerName === undefined
            ? '复用官方语音输入插件模型'
            : `复用官方语音输入插件：${host.providerName}`,
      };
    }
    if (mode === 'host') {
      const missing = hostUnavailable(language, host);
      return { settings: null, kind: 'none', reason: missing.reason, detail: missing.detail };
    }
  }

  const wantLocal = mode === 'local' || mode === 'auto';
  if (wantLocal) {
    const detection = facts.detection;
    if (detection.exe === null || !detection.ready) {
      const localReason = detection.exe === null ? 'local_missing_engine' : 'local_missing_model';
      const localDetail = detection.reason ?? '本地转写尚未就绪';
      if (mode === 'auto' && host !== undefined && host.available) {
        const missing = hostUnavailable(language, host);
        return {
          settings: null,
          kind: 'none',
          reason: missing.reason,
          detail: `${missing.detail}；${localDetail}`,
        };
      }
      return {
        settings: null,
        kind: 'none',
        reason: localReason,
        detail: localDetail,
      };
    }
    const enginePreset = modelPreset(detection.modelId);
    const needsModel = LOCAL_ENGINES.find((entry) => entry.id === detection.engine)?.needsModelFile ?? false;
    if (needsModel && detection.modelPath === null) {
      return { settings: null, kind: 'none', reason: 'local_missing_model', detail: '还缺模型文件' };
    }
    return {
      settings: {
        provider: 'local_cli',
        baseUrl: null,
        model: detection.exe,
        apiKey: null,
        language,
        args: buildLocalArgs(detection.engine, {
          modelPath: detection.modelPath,
          modelName: detection.modelId === 'small-q5_1' ? 'small' : detection.modelId === 'base-q5_1' ? 'base' : 'medium',
          language,
          threads: facts.localThreads ?? 0,
        }),
        timeoutMs: facts.localTimeoutMs,
        maxConcurrency: 1,
      },
      kind: 'local',
      reason: null,
      detail: needsModel ? `本地模型：${enginePreset.label}` : null,
    };
  }

  return { settings: null, kind: 'none', reason: 'engine_off', detail: '尚未选择转写引擎' };
}
