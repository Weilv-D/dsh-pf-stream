/**
 * 官方「语音输入」实验插件的宿主服务适配层。
 *
 * 只依赖鸭子类型，不 import 官方包，也不读取模型文件：
 * - 模型格式是 ONNX，不能给 whisper.cpp 使用；
 * - 官方服务负责 VAD、worker 预热与模型完整性校验；
 * - 官方包标注 experimental，直接依赖类型会把插件锁死在某个版本。
 */

/** 官方 provider 的 `sensevoice-local` id；只在没有同名 provider 时回退到任意 host-local。 */
export const HOST_SPEECH_PROVIDER_ID = 'sensevoice-local';

export interface HostSpeechPreparationView {
  phase?: string | undefined;
  /** 官方 provider 用 snapshot() 暴露当前准备阶段。 */
  snapshot?: (() => { phase?: string | undefined } | undefined) | undefined;
}

export interface HostSpeechProviderView {
  id?: string | undefined;
  name?: string | undefined;
  location?: string | undefined;
  languages?: readonly string[] | undefined;
  preparation?: HostSpeechPreparationView | null | undefined;
}

export interface HostSpeechSnapshot {
  providers?: readonly HostSpeechProviderView[] | undefined;
  selection?: { providerId?: string | undefined; language?: string | undefined } | null | undefined;
}

export interface HostSpeechTranscript {
  text?: string | undefined;
  audioSeconds?: number | undefined;
  inferenceSeconds?: number | undefined;
}

/**
 * 我们实际使用的最小服务面。官方完整服务还有 register/follow/configure/prepare：
 * 本插件不注册 provider、不自动下载模型，因此不把它们纳入接口。
 */
export interface HostSpeechService {
  snapshot(): HostSpeechSnapshot;
  resolve(request: {
    audio: Uint8Array;
    providerId?: string | undefined;
    language?: string | undefined;
  }): unknown;
  transcribe(spec: unknown, signal: AbortSignal): Promise<HostSpeechTranscript>;
}

export interface HostSpeechFacts {
  /** 宿主是否暴露了 speechToText 服务。 */
  available: boolean;
  /** provider 处于 ready/standby，且当前没有已知错误。 */
  ready: boolean;
  providerId: string | null;
  providerName: string | null;
  /** 官方 preparation 阶段；null 表示读不到。 */
  phase: string | null;
  languages: readonly string[];
  /** 面向用户的原因；ready 时为 null。 */
  reason: string | null;
  /** 运行时对象；只在本次调用内使用，不写入配置或缓存。 */
  service: HostSpeechService | null;
}

function phaseOf(provider: HostSpeechProviderView): string | null {
  try {
    const snapshot = provider.preparation?.snapshot?.();
    if (snapshot !== undefined && typeof snapshot.phase === 'string') return snapshot.phase;
  } catch {
    // 官方 provider 状态读取失败按未就绪处理，不让设置页/工具调用崩。
  }
  const direct = provider.preparation?.phase;
  return typeof direct === 'string' ? direct : null;
}

function isReadyPhase(phase: string | null): boolean {
  return phase === 'ready' || phase === 'standby';
}

/**
 * 探测官方语音输入服务。
 *
 * 注意：snapshot() 是同步的，但 provider 的 readiness 会随 prepare/worker 回收变化，
 * 因此本函数必须在每次解析设置时调用，不能把结果永久缓存。
 */
export function probeHostSpeech(
  service: HostSpeechService | null | undefined,
  preferredProviderId = HOST_SPEECH_PROVIDER_ID,
): HostSpeechFacts {
  if (service === null || service === undefined || typeof service.snapshot !== 'function') {
    return {
      available: false,
      ready: false,
      providerId: null,
      providerName: null,
      phase: null,
      languages: [],
      reason: '未安装或未启用官方语音输入插件',
      service: null,
    };
  }

  let snapshot: HostSpeechSnapshot;
  try {
    snapshot = service.snapshot();
  } catch {
    return {
      available: true,
      ready: false,
      providerId: null,
      providerName: null,
      phase: null,
      languages: [],
      reason: '官方语音输入插件状态不可读',
      service,
    };
  }

  const providers = Array.isArray(snapshot.providers) ? snapshot.providers : [];
  const hostProviders = providers.filter((provider) => provider.location === 'host-local');
  // 只接受 host-local；同名 provider 若被官方标成 cloud，绝不当作本地复用，
  // 否则会把音频发给云端，违背「复用本地模型」的语义。
  const provider =
    hostProviders.find((entry) => entry.id === preferredProviderId) ?? hostProviders[0] ?? null;

  if (provider === null) {
    return {
      available: true,
      ready: false,
      providerId: null,
      providerName: null,
      phase: null,
      languages: [],
      reason: '官方语音输入插件没有本地转写提供方',
      service,
    };
  }

  const phase = phaseOf(provider);
  const languages = Array.isArray(provider.languages) ? provider.languages : [];
  const ready = isReadyPhase(phase);
  return {
    available: true,
    ready,
    providerId: provider.id ?? preferredProviderId,
    providerName: provider.name ?? provider.id ?? preferredProviderId,
    phase,
    languages,
    reason: ready
      ? null
      : phase === 'unprepared'
        ? '官方语音输入插件模型未准备（请先在插件详情页下载并准备）'
        : `官方语音输入插件模型状态：${phase ?? '未知'}`,
    service,
  };
}

/** 语言是否被 provider 支持；null/auto 由官方自动识别。 */
export function hostSpeechSupportsLanguage(
  languages: readonly string[],
  language: string | null | undefined,
): boolean {
  if (language === null || language === undefined || language.trim() === '' || language === 'auto') {
    return true;
  }
  const wanted = language.toLowerCase();
  const base = wanted.split(/[-_]/)[0] ?? wanted;
  return languages.some((entry) => {
    const value = entry.toLowerCase();
    return value === wanted || value === base;
  });
}
