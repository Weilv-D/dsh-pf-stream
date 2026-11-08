/**
 * 官方「语音输入」实验插件的宿主服务适配层。
 *
 * 只依赖鸭子类型，不 import 官方包，也不读取模型文件：
 * - 模型格式是 ONNX，不能给 whisper.cpp 使用；
 * - 官方服务负责 VAD、worker 预热与模型完整性校验；
 * - 官方包标注 experimental，直接依赖类型会把插件锁死在某个版本。
 */

/** 官方 SenseVoice provider 的首选 id；没有同名 provider 时可退回任意有 id 的 host-local。 */
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
  language?: string | null,
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
  const hostLocalProviders = providers.filter((provider) => provider.location === 'host-local');
  // 只接受 host-local；官方 resolve 按 id 在全部 provider 中查找，因此没有 id 的
  // host provider 不能靠 preferredProviderId 伪造 id，否则可能命中同名云端 provider。
  const hostProviders = hostLocalProviders.filter(
    (provider) => typeof provider.id === 'string' && provider.id.trim() !== '',
  );
  const phases = new Map(
    hostProviders.map((entry) => [entry, phaseOf(entry)] as const),
  );
  const readyProviders = hostProviders.filter((entry) => isReadyPhase(phases.get(entry) ?? null));
  // 有目标语言时优先选择「就绪且语言精确匹配」的 provider；若一个都没有，
  // 仍回退到就绪 provider，让 hostUnavailable 能报 host_language_unsupported，
  // 而不是误报 host_not_ready。
  const languageReady =
    language === undefined || language === null
      ? readyProviders
      : readyProviders.filter((entry) => resolveHostSpeechLanguage(entry.languages ?? [], language).supported);
  const candidates = languageReady.length > 0 ? languageReady : readyProviders;
  // 官方语音输入自己的 selection 若指向 host-local provider，应尊重用户选择；
  // 若它指向 cloud，则忽略（本插件只复用本地模型）。
  const selectedId = snapshot.selection?.providerId?.trim();
  const provider =
    candidates.find((entry) => selectedId !== undefined && entry.id === selectedId) ??
    candidates.find((entry) => entry.id === preferredProviderId) ??
    candidates[0] ??
    // 没有 ready provider 时保留首选用于展示原因；不要因为别的 provider 未就绪而掩盖首选状态。
    hostProviders.find((entry) => entry.id === preferredProviderId) ??
    (selectedId === undefined ? undefined : hostProviders.find((entry) => entry.id === selectedId)) ??
    hostProviders[0] ??
    null;

  if (provider === null) {
    return {
      available: true,
      ready: false,
      providerId: null,
      providerName: null,
      phase: null,
      languages: [],
      reason:
        hostLocalProviders.length > 0
          ? '官方语音输入提供方缺少 id，拒绝调用'
          : '官方语音输入插件没有本地转写提供方',
      service,
    };
  }

  const providerId = provider.id?.trim();
  if (providerId === undefined || providerId === '') {
    // 上面的 filter 已排除；保留防御，避免未来改动把空 id 带进来。
    return {
      available: true,
      ready: false,
      providerId: null,
      providerName: null,
      phase: null,
      languages: [],
      reason: '官方语音输入提供方缺少 id，拒绝调用',
      service,
    };
  }

  // 官方 resolve 用全局 id 查 provider。若同一 id 同时存在 host-local 与 cloud
  // provider，官方可能命中云端；这里直接拒绝歧义 id，避免音频静默上云。
  const sameId = providers.filter((entry) => entry.id?.trim() === providerId);
  if (sameId.length !== 1) {
    return {
      available: true,
      ready: false,
      providerId: null,
      providerName: null,
      phase: null,
      languages: [],
      reason: '官方语音输入提供方 id 重复，拒绝调用',
      service,
    };
  }

  const phase = phases.get(provider) ?? null;
  const languages = Array.isArray(provider.languages) ? provider.languages : [];
  const ready = isReadyPhase(phase);
  return {
    available: true,
    ready,
    providerId,
    providerName: provider.name ?? providerId,
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

/** 官方 provider 支持的语言；官方 resolve 使用严格相等，必须回传 provider 列表里的原值。 */
export interface HostSpeechLanguageChoice {
  supported: boolean;
  /** 传给官方 resolve 的精确语言；null 表示省略请求语言。 */
  language: string | null;
}

export function resolveHostSpeechLanguage(
  languages: readonly string[],
  language: string | null | undefined,
): HostSpeechLanguageChoice {
  if (language === null || language === undefined || language.trim() === '') {
    return { supported: true, language: null };
  }
  const wanted = language.trim();
  const lower = wanted.toLowerCase();
  if (lower === 'auto') {
    const auto = languages.find((entry) => entry.toLowerCase() === 'auto');
    return { supported: true, language: auto ?? null };
  }
  const exact = languages.find((entry) => entry.toLowerCase() === lower);
  if (exact !== undefined) return { supported: true, language: exact };
  const base = lower.split(/[-_]/)[0] ?? lower;
  const baseEntry = languages.find((entry) => entry.toLowerCase() === base);
  if (baseEntry !== undefined) return { supported: true, language: baseEntry };
  return { supported: false, language: null };
}

/** 语言是否被 provider 支持：resolveHostSpeechLanguage(...).supported。 */
