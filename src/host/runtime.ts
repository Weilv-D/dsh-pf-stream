/**
 * 宿主侧运行时：探测结果、云端密钥、安装任务与设置命名空间的唯一持有者。
 *
 * 为什么需要它：设置页要看到「现在到底能不能转写」，而工具调用要拿到同样
 * 的结论。两边共用一份事实，避免页面显示就绪、实际调用却回退。
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PfStreamPluginConfig } from '../types.js';
import { CLOUD_PRESETS, cloudPreset, managedPaths, modelPreset } from '../asr/catalog.js';
import { detectLocalEngine, type LocalEngineSnapshot } from '../asr/detect.js';
import type { AsrRuntimeFacts } from '../asr/engine.js';
import { resolveAsr } from '../asr/engine.js';
import { LocalAsrInstaller, type InstallJob, type InstallTarget } from '../asr/install.js';

export interface CredentialsService {
  resolve(ref: string): Promise<{ value: string; source?: string } | undefined>;
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

/** Loader 条目（只取设置页需要的字段）。 */
export interface ConfigEntry {
  options: { id: string; name?: string; config?: Record<string, unknown> };
  fiber?: unknown;
}

/**
 * 完整配置编辑器：写入 profile patch 并走正常 Loader 路径。
 * 为什么不用 settings：它只投影 volatile 字段，而我们的面板要改的是普通配置项。
 */
export interface ConfigEditorService {
  entries(): ConfigEntry[];
  edit(
    entry: ConfigEntry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
}

export interface WebRequestLike {
  method?: string | undefined;
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
}

export interface WebResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(body?: string): void;
}

export interface WebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (request: WebRequestLike, response: WebResponseLike) => void;
}

export interface WebServerService {
  register(route: WebRoute): () => void;
}

export interface HostServices {
  credentials?: CredentialsService | undefined;
  /** 首选写入通道：完整配置编辑（无需 volatile）。 */
  configEditor?: ConfigEditorService | undefined;
  webServer?: WebServerService | undefined;
}

export interface CloudStatus {
  preset: string;
  label: string;
  baseUrl: string;
  model: string;
  keyConfigured: boolean;
  editable: boolean;
}

export interface AsrStatus {
  engine: LocalEngineSnapshot;
  /** 用户配置的引擎模式（auto/local/cloud/off/legacy）。 */
  mode: string;
  cloud: CloudStatus;
  /** 旧版 provider 直连配置是否存在（0.2.x 兼容）。 */
  legacyProvider: string;
  /** 缓存目录与占用（字节）。 */
  cacheDir: string;
  cacheBytes: number;
  /** 本地资源路径（不保证存在，供页面展示）。 */
  managed: { exe: string; modelDir: string };
  modelId: string;
  modelLabel: string;
  /** 当前生效的配置值，供页面回填表单。 */
  config: {
    engine: string;
    language: string;
    threads: number;
    modelId: string;
  };
  install: InstallJob | null;
  /** profile 里的配置条目 id（能写入时非 null）。 */
  configNamespace: string | null;
  configWritable: boolean;
  /** 当前实际会使用的引擎（auto 解析结果），供页面如实显示。 */
  active: {
    kind: 'cloud' | 'local' | 'none';
    preset: string;
    presetLabel: string;
  };
  /** 一句话结论：现在能否转写。 */
  ready: boolean;
  summary: string;
}

const DETECT_TTL_MS = 5_000;
const KEY_TTL_MS = 10_000;

export class HostRuntime {
  private detectionCache: { at: number; value: LocalEngineSnapshot } | null = null;
  private keyCache: { at: number; value: Record<string, string | null> } | null = null;
  private lastFacts: AsrRuntimeFacts | null = null;
  /**
   * 本会话内已保存的配置补丁。configEditor 负责持久化，但运行中的插件实例
   * 不会立刻拿到新配置，所以这里保留一份覆盖层，保证保存后面板与工具立即生效。
   */
  private overrides: Record<string, unknown> = {};
  readonly installer: LocalAsrInstaller;

  constructor(
    private readonly getConfig: () => PfStreamPluginConfig,
    private readonly services: HostServices,
  ) {
    const config = this.getConfig();
    this.installer = new LocalAsrInstaller({
      cacheDir: config.audio.cacheDir,
      modelId: config.audio.asr.local?.modelId ?? 'small-q5_1',
      onFinished: () => this.invalidate(),
    });
  }

  private config(): PfStreamPluginConfig {
    const base = this.getConfig();
    if (Object.keys(this.overrides).length === 0) return base;
    return mergeConfig(
      base as unknown as Record<string, unknown>,
      this.overrides,
    ) as unknown as PfStreamPluginConfig;
  }

  /** 供 HTTP 层读取当前配置（只读）。 */
  currentConfig(): PfStreamPluginConfig {
    return this.config();
  }

  invalidate(): void {
    this.detectionCache = null;
    this.keyCache = null;
  }

  /** 按最新配置同步安装器参数后再开始安装（模型大小可能刚被改过）。 */
  startInstall(target: InstallTarget = 'all'): InstallJob {
    const config = this.config();
    this.installer.update({
      cacheDir: config.audio.cacheDir,
      modelId: config.audio.asr.local?.modelId ?? 'small-q5_1',
    });
    return this.installer.start(target);
  }

  detection(): LocalEngineSnapshot {
    const now = Date.now();
    if (this.detectionCache !== null && now - this.detectionCache.at < DETECT_TTL_MS) {
      return this.detectionCache.value;
    }
    const config = this.config();
    const value = detectLocalEngine({
      cacheDir: config.audio.cacheDir,
      binPath: config.audio.asr.local?.binPath,
      modelPath: config.audio.asr.local?.modelPath,
      modelId: config.audio.asr.local?.modelId,
    });
    this.detectionCache = { at: now, value };
    return value;
  }

  /** 读取各云端预设的密钥（不返回值给页面，只给「是否配置」）。 */
  async keys(): Promise<Record<string, string | null>> {
    const now = Date.now();
    if (this.keyCache !== null && now - this.keyCache.at < KEY_TTL_MS) {
      return this.keyCache.value;
    }
    const value: Record<string, string | null> = {};
    const credentials = this.services.credentials;
    for (const preset of CLOUD_PRESETS) {
      if (credentials === undefined) {
        value[preset.id] = null;
        continue;
      }
      try {
        const hit = await credentials.resolve(preset.keyRef);
        value[preset.id] = hit?.value?.trim() ?? null;
      } catch {
        value[preset.id] = null;
      }
    }
    this.keyCache = { at: now, value };
    return value;
  }

  async facts(): Promise<AsrRuntimeFacts> {
    const value: AsrRuntimeFacts = {
      detection: this.detection(),
      keys: await this.keys(),
      localTimeoutMs: this.config().audio.asr.local?.timeoutMs ?? 300_000,
      localThreads: this.config().audio.asr.local?.threads ?? 0,
    };
    this.lastFacts = value;
    return value;
  }

  /**
   * 同步取事实（工具调用路径用）：密钥刷新是异步的，这里用最近一次快照，
   * 首次调用前由 apply 期 refresh() 预热；缺快照时按空密钥处理。
   * 探测必须每次现算：刚装完模型就调用，不能继续用安装前的旧快照。
   */
  syncFacts(): AsrRuntimeFacts {
    const value: AsrRuntimeFacts = {
      detection: this.detection(),
      keys: this.keyCache?.value ?? this.lastFacts?.keys ?? {},
      localTimeoutMs: this.config().audio.asr.local?.timeoutMs ?? 300_000,
      localThreads: this.config().audio.asr.local?.threads ?? 0,
    };
    this.lastFacts = value;
    return value;
  }

  /** 预热/刷新密钥快照。 */
  async refresh(): Promise<void> {
    await this.facts();
  }

  async setKey(presetId: string, value: string): Promise<void> {
    const credentials = this.services.credentials;
    if (credentials === undefined) throw new Error('宿主没有提供凭据服务，无法保存密钥');
    const preset = cloudPreset(presetId);
    const trimmed = value.trim();
    if (trimmed === '') {
      await credentials.unset(preset.keyRef);
    } else {
      await credentials.set(preset.keyRef, trimmed);
    }
    this.keyCache = null;
  }

  async keyInfo(presetId: string): Promise<{ configured: boolean; source: string | null }> {
    const credentials = this.services.credentials;
    if (credentials === undefined) return { configured: false, source: null };
    try {
      const info = await credentials.describe(cloudPreset(presetId).keyRef);
      return { configured: info.configured, source: info.source ?? null };
    } catch {
      return { configured: false, source: null };
    }
  }

  /** 本插件在 profile 里的配置条目：按条目 id 或包名匹配。 */
  private resolveConfigEntry(): ConfigEntry | null {
    const editor = this.services.configEditor;
    if (editor === undefined) return null;
    try {
      const entries = editor.entries();
      return (
        entries.find((entry) => entry.options.id === 'include:dsh-pf-stream') ??
        entries.find((entry) => entry.options.id.includes('dsh-pf-stream')) ??
        entries.find((entry) => entry.options.name === 'dsh-pf-stream') ??
        entries.find((entry) => (entry.options.name ?? '').includes('dsh-pf-stream')) ??
        null
      );
    } catch {
      return null;
    }
  }

  /** 当前可写入的配置条目 id；不可写时为 null。 */
  resolveConfigNamespace(): string | null {
    const entry = this.resolveConfigEntry();
    return entry === null ? null : entry.options.id;
  }

  /**
   * 写配置：把 patch 深合并进当前 raw config，再由 Loader 持久化。
   * 只写用户改动的字段，其余配置（含 40 余项高级项）原样保留。
   */
  async patchConfig(patch: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
    const editor = this.services.configEditor;
    const entry = this.resolveConfigEntry();
    if (editor === undefined || entry === null) {
      return { ok: false, message: '宿主未暴露配置编辑服务，请直接编辑 cordis.patch.yml' };
    }
    try {
      await editor.edit(entry, (current) => mergeConfig(current, patch));
      // 持久化已完成；覆盖层让当前运行实例立即读到新值。
      this.overrides = mergeConfig(this.overrides, patch);
      this.invalidate();
      const next = this.config();
      this.installer.update({ modelId: next.audio.asr.local?.modelId ?? 'small-q5_1' });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(): Promise<AsrStatus> {
    const config = this.config();
    const detection = this.detection();
    const keys = await this.keys();
    const preset = cloudPreset(config.audio.asr.preset ?? null);
    const keyConfigured = (keys[preset.id] ?? null) !== null;
    const cloudBase = preset.editable ? config.audio.asr.baseUrl?.trim() ?? '' : preset.baseUrl;
    const cloudModel = preset.editable ? config.audio.asr.model?.trim() ?? '' : preset.model;
    const model = modelPreset(detection.modelId);
    const managed = managedPaths(config.audio.cacheDir);
    const mode = config.audio.asr.engine ?? 'auto';
    const namespace = this.resolveConfigNamespace();

    const legacy = config.audio.asr.provider;

    const resolution = resolveAsr(
      config.audio.asr,
      undefined,
      process.env,
      {
        detection,
        keys,
        localTimeoutMs: config.audio.asr.local?.timeoutMs ?? 300_000,
        localThreads: config.audio.asr.local?.threads ?? 0,
      },
    );

    const ready = config.audio.mode !== 'off' && resolution.settings !== null;

    const summary = ready
      ? resolution.kind === 'cloud'
        ? `云端转写就绪（${preset.label}）`
        : `本地转写就绪（${detection.engine}）`
      : mode === 'off'
        ? '转写已关闭'
        : '还不能转写语音：安装本地模型或配置云端密钥';

    const activeKind =
      resolution.kind === 'legacy'
        ? resolution.settings?.provider === 'local_cli'
          ? 'local'
          : 'cloud'
        : resolution.kind;

    return {
      engine: detection,
      mode,
      cloud: {
        preset: preset.id,
        label: preset.label,
        baseUrl: cloudBase,
        model: cloudModel,
        keyConfigured,
        editable: preset.editable,
      },
      legacyProvider: legacy,
      cacheDir: config.audio.cacheDir,
      cacheBytes: cacheFileBytes(config.audio.cacheDir),
      managed,
      modelId: model.id,
      modelLabel: model.label,
      config: {
        engine: mode,
        language: config.audio.asr.language ?? '',
        threads: config.audio.asr.local?.threads ?? 0,
        modelId: model.id,
      },
      install: this.installer.current(),
      configNamespace: namespace,
      configWritable: namespace !== null,
      active: {
        kind: activeKind,
        preset: preset.id,
        presetLabel: preset.label,
      },
      ready,
      summary,
    };
  }

  /** 清理转写缓存（仅根目录的指纹 JSON/临时文件，保留 asr/ 下的模型与引擎）。 */
  clearCache(): { removed: number; bytes: number } {
    const dir = this.config().audio.cacheDir;
    let removed = 0;
    let bytes = 0;
    try {
      for (const name of readdirSync(dir)) {
        if (!/^[0-9a-f]{32}(-[0-9a-f]{16})?\.(json|tmp)$/.test(name) && !/\.json\.tmp$/.test(name)) continue;
        const path = join(dir, name);
        try {
          const size = statSync(path).size;
          rmSync(path, { force: true });
          removed += 1;
          bytes += size;
        } catch {
          // 单文件失败不阻断整体清理
        }
      }
    } catch {
      return { removed: 0, bytes: 0 };
    }
    return { removed, bytes };
  }
}

/**
 * 转写缓存占用（只算根目录指纹文件，不含 asr/ 下的模型与引擎）。
 * 与 clearCache 的口径一致，避免把 181MB 模型误报成“缓存”。
 */
function cacheFileBytes(dir: string): number {
  let bytes = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!/^[0-9a-f]{32}(-[0-9a-f]{16})?\.(json|tmp)$/.test(name) && !/\.json\.tmp$/.test(name)) continue;
      try {
        bytes += statSync(join(dir, name)).size;
      } catch {
        // 单文件失败不影响统计
      }
    }
  } catch {
    return 0;
  }
  return bytes;
}

/** 深合并配置 patch：只覆盖给出的叶子，其余字段（含高级项）原样保留。 */
function mergeConfig(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    const existing = next[key];
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing !== null &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      next[key] = mergeConfig(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      next[key] = value;
    }
  }
  return next;
}
