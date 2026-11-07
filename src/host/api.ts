/**
 * 插件设置页的 Host API。
 *
 * 为什么是 HTTP 而不是 IPC：持久 bundle 的浏览器半只有 `fetch` 可用
 * （`harness.handle` 只属于 agent 运行时里的动态插件）。dshmarket 与
 * billion-context 都走同一条路，宿主 `webServer` 提供同源路由。
 *
 * 路由全部在 `/dsh-pf-stream/api` 前缀下，只做本插件自己的事：
 * 状态、安装、取消、验证、写配置、存密钥、清缓存。
 */

import { existsSync } from 'node:fs';
import { resolveBinPaths } from '../utils/ffmpegBin.js';
import { cloudPreset, CLOUD_PRESETS, LOCAL_ENGINES } from '../asr/catalog.js';
import { locateOnPath } from '../asr/detect.js';
import { resolveAsr } from '../asr/engine.js';
import { verifyCloud, verifyLocal } from '../asr/verify.js';
import type { PfStreamPluginConfig } from '../types.js';
import type { HostRuntime, WebRequestLike, WebResponseLike, WebServerService } from './runtime.js';

export const API_PREFIX = '/dsh-pf-stream/api';

/** 只接受 POST 的路由；不在此表也不是 GET /status 的路径一律 404。 */
const POST_ROUTES = new Set(['/install', '/install/cancel', '/config', '/key', '/test', '/cache/clear', '/detect']);

const MAX_BODY_BYTES = 64 * 1024;

interface ApiDeps {
  runtime: HostRuntime;
  /** 注册路由；返回 disposer。 */
  webServer: WebServerService;
}

function send(response: WebResponseLike, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function readBody(request: WebRequestLike): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', (error) => reject(error));
  });
}

/** 同源校验：带 Origin 的请求必须与 Host 同源（防跨站写入）。 */
function sameOrigin(request: WebRequestLike): boolean {
  const origin = request.headers.origin;
  const value = Array.isArray(origin) ? origin[0] : origin;
  if (value === undefined || value === '') return true;
  const host = request.headers.host;
  const hostValue = Array.isArray(host) ? host[0] : host;
  if (hostValue === undefined) return false;
  try {
    return new URL(value).host === hostValue;
  } catch {
    return false;
  }
}

const ENGINE_MODES = new Set(['auto', 'local', 'cloud', 'host', 'off', 'legacy']);

interface ConfigField {
  path: string[];
  validate: (value: unknown) => boolean;
  normalize: (value: unknown) => unknown;
}

function shortString(value: unknown): boolean {
  return typeof value === 'string' && value.length <= 300;
}

/** 设置页只允许改这些字段（其余走 cordis.patch.yml 或高级配置）。 */
const CONFIG_FIELDS: Record<string, ConfigField> = {
  mode: {
    path: ['audio', 'mode'],
    validate: (value) => value === 'auto' || value === 'off',
    normalize: (value) => value,
  },
  engine: {
    path: ['audio', 'asr', 'engine'],
    validate: (value) => typeof value === 'string' && ENGINE_MODES.has(value),
    normalize: (value) => value,
  },
  preset: {
    path: ['audio', 'asr', 'preset'],
    validate: (value) => CLOUD_PRESETS.some((preset) => preset.id === value),
    normalize: (value) => value,
  },
  baseUrl: {
    path: ['audio', 'asr', 'baseUrl'],
    validate: shortString,
    normalize: (value) => (typeof value === 'string' ? value.trim() : value),
  },
  model: {
    path: ['audio', 'asr', 'model'],
    validate: shortString,
    normalize: (value) => (typeof value === 'string' ? value.trim() : value),
  },
  language: {
    path: ['audio', 'asr', 'language'],
    validate: shortString,
    normalize: (value) => (typeof value === 'string' ? value.trim() : value),
  },
  modelId: {
    path: ['audio', 'asr', 'local', 'modelId'],
    validate: (value) =>
      typeof value === 'string' && ['base-q5_1', 'small-q5_1', 'medium-q5_0'].includes(value),
    normalize: (value) => value,
  },
  threads: {
    path: ['audio', 'asr', 'local', 'threads'],
    // 上限与执行层 buildLocalArgs 的钳制一致（16）：面板放行 32 会静默按 16 运行
    validate: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 16,
    normalize: (value) => Math.trunc(value as number),
  },
};

function nestPatch(path: string[], value: unknown): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  path.forEach((key, index) => {
    if (index === path.length - 1) {
      cursor[key] = value;
      return;
    }
    const next: Record<string, unknown> = {};
    cursor[key] = next;
    cursor = next;
  });
  return root;
}

async function statusPayload(runtime: HostRuntime): Promise<Record<string, unknown>> {
  const config: PfStreamPluginConfig = runtime.currentConfig();
  const bins = resolveBinPaths({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath });
  const ffmpegOk = existsSync(bins.ffmpeg) || locateOnPath(['ffmpeg']) !== null;
  const ffprobeOk = existsSync(bins.ffprobe) || locateOnPath(['ffprobe']) !== null;
  const status = await runtime.status();
  const keys = await runtime.keys();
  return {
    ...status,
    ffmpeg: {
      available: ffmpegOk && ffprobeOk,
      ffmpeg: bins.ffmpeg,
      ffprobe: bins.ffprobe,
    },
    presets: CLOUD_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      baseUrl: preset.baseUrl,
      model: preset.model,
      keyUrl: preset.keyUrl,
      editable: preset.editable,
      keyConfigured: (keys[preset.id] ?? null) !== null,
    })),
    engines: LOCAL_ENGINES.map((engine) => ({ id: engine.id, label: engine.label })),
  };
}

/**
 * 注册全部路由。一次 `prefix` 注册即可，内部再按 pathname 分发，
 * 减少与宿主路由表的耦合面。
 */
export function registerApi(deps: ApiDeps): () => void {
  const { runtime } = deps;
  const handler = (request: WebRequestLike, response: WebResponseLike): void => {
    void (async () => {
      const method = (request.method ?? 'GET').toUpperCase();
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (!url.pathname.startsWith(API_PREFIX)) {
        send(response, 404, { ok: false, error: 'not_found' });
        return;
      }
      const route = url.pathname.slice(API_PREFIX.length) || '/';

      if (!sameOrigin(request)) {
        send(response, 403, { ok: false, error: 'cross_origin' });
        return;
      }

      if (method === 'GET' && route === '/status') {
        send(response, 200, { ok: true, data: await statusPayload(runtime) });
        return;
      }

      const known = route === '/status' || POST_ROUTES.has(route);
      if (!known) {
        send(response, 404, { ok: false, error: 'not_found' });
        return;
      }

      if (method !== 'POST') {
        send(response, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }

      const contentType = String(request.headers['content-type'] ?? '');
      if (!contentType.includes('application/json')) {
        send(response, 415, { ok: false, error: 'json_required' });
        return;
      }

      let body: Record<string, unknown> = {};
      const raw = await readBody(request);
      if (raw.trim() !== '') {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          send(response, 400, { ok: false, error: 'invalid_body' });
          return;
        }
        body = parsed as Record<string, unknown>;
      }

      if (route === '/install') {
        const target = body.target === 'model' || body.target === 'engine' ? body.target : 'all';
        const job = runtime.startInstall(target);
        send(response, 200, { ok: true, data: job });
        return;
      }
      if (route === '/install/cancel') {
        runtime.installer.cancel();
        send(response, 200, { ok: true, data: runtime.installer.current() });
        return;
      }
      if (route === '/config') {
        const field = typeof body.field === 'string' ? body.field : '';
        const entry = CONFIG_FIELDS[field];
        if (entry === undefined || !entry.validate(body.value)) {
          send(response, 400, { ok: false, error: 'invalid_field' });
          return;
        }
        const result = await runtime.patchConfig(nestPatch(entry.path, entry.normalize(body.value)));
        send(response, result.ok ? 200 : 409, result);
        return;
      }
      if (route === '/key') {
        const presetId = typeof body.preset === 'string' ? body.preset : '';
        const preset = CLOUD_PRESETS.find((entry) => entry.id === presetId);
        if (preset === undefined) {
          send(response, 400, { ok: false, error: 'unknown_preset' });
          return;
        }
        const key = typeof body.key === 'string' ? body.key : '';
        if (key.length > 4096) {
          send(response, 400, { ok: false, error: 'key_too_long' });
          return;
        }
        try {
          await runtime.setKey(preset.id, key);
          const info = await runtime.keyInfo(preset.id);
          send(response, 200, { ok: true, data: info });
        } catch (error) {
          send(response, 409, {
            ok: false,
            error: 'credential_rejected',
            message: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (route === '/test') {
        const facts = await runtime.facts();
        const config = runtime.currentConfig();
        const resolution = resolveAsr(config.audio.asr, undefined, process.env, facts);
        if (resolution.settings === null) {
          send(response, 409, {
            ok: false,
            error: resolution.reason ?? 'not_ready',
            message: resolution.detail ?? '转写引擎尚未就绪',
          });
          return;
        }
        const settings = resolution.settings;
        const engine = facts.detection.engine;
        const label =
          resolution.kind === 'cloud'
            ? `云端 ${cloudPreset(config.audio.asr.preset ?? null).label}`
            : resolution.kind === 'host'
              ? `官方语音输入（${facts.hostSpeech?.providerName ?? facts.hostSpeech?.providerId ?? 'SenseVoice'}）`
              : (LOCAL_ENGINES.find((entry) => entry.id === engine)?.label ?? engine);
        if (resolution.kind === 'host') {
          send(response, 200, {
            ok: true,
            data: {
              engine: label,
              latencyMs: 0,
              readinessOnly: true,
              message: '官方语音输入插件模型已就绪；此处只检查就绪，实际转写在视频调用时执行',
            },
          });
          return;
        }
        const result =
          resolution.kind === 'cloud' ? await verifyCloud(settings) : await verifyLocal(settings);
        send(response, 200, { ok: true, data: { ...result, engine: label, durationMs: result.latencyMs } });
        return;
      }
      if (route === '/cache/clear') {
        const cleared = runtime.clearCache();
        send(response, 200, { ok: true, data: cleared });
        return;
      }
      if (route === '/detect') {
        runtime.invalidate();
        send(response, 200, { ok: true, data: await statusPayload(runtime) });
        return;
      }

      send(response, 404, { ok: false, error: 'not_found' });
    })().catch((error: unknown) => {
      send(response, 500, {
        ok: false,
        error: 'internal_error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };

  return deps.webServer.register({ kind: 'prefix', path: API_PREFIX, handler });
}
