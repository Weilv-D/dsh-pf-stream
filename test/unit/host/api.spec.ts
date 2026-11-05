import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { API_PREFIX, registerApi } from '../../../src/host/api.js';
import type { HostRuntime, WebRequestLike, WebResponseLike } from '../../../src/host/runtime.js';

interface FakeResponse extends WebResponseLike {
  status: number;
  body: string;
}

const STATUS = {
  engine: 'managed',
  mode: 'auto',
  cloud: { preset: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com', model: 'whisper-1', keyConfigured: false, editable: false },
  legacyProvider: 'none',
  cacheDir: 'C:/cache',
  cacheBytes: 0,
  managed: { exe: null, modelDir: 'C:/cache/asr/models' },
  modelId: 'small-q5_1',
  modelLabel: 'Small（约 190MB）',
  install: null,
  settingsNamespace: 'include:dsh-pf-stream',
  settingsWritable: true,
  ready: false,
  summary: '未安装本地转写引擎',
};

function fakeRuntime(over: Partial<Record<string, unknown>> = {}): { runtime: HostRuntime; patches: unknown[] } {
  const patches: unknown[] = [];
  const runtime = {
    currentConfig: () => ({ ffmpegPath: undefined, ffprobePath: undefined, audio: { asr: { preset: 'openai' } } }),
    status: async () => STATUS,
    patchConfig: async (patch: unknown) => {
      patches.push(patch);
      return { ok: true, namespace: 'include:dsh-pf-stream', revision: 3 };
    },
    installer: {
      start: () => ({ id: 'job-1', phase: 'preparing' }),
      cancel: () => undefined,
      current: () => null,
    },
    startInstall: () => ({ id: 'job-1', phase: 'preparing' }),
    setKey: async () => undefined,
    keyInfo: async () => ({ configured: true }),
    keys: async () => ({}),
    facts: async () => ({ detection: {}, keys: {}, localTimeoutMs: 300000 }),
    invalidate: () => undefined,
    clearCache: () => ({ removed: 0, bytes: 0 }),
    ...over,
  } as unknown as HostRuntime;
  return { runtime, patches };
}

class FakeRequest extends EventEmitter implements WebRequestLike {
  method: string;
  url: string;
  headers: Record<string, string>;
  constructor(options: { method: string; url: string; headers?: Record<string, string>; body?: string }) {
    super();
    this.method = options.method;
    this.url = options.url;
    this.headers = options.headers ?? {};
    if (options.body !== undefined) {
      setImmediate(() => {
        this.emit('data', Buffer.from(options.body!));
        this.emit('end');
      });
    } else {
      setImmediate(() => this.emit('end'));
    }
  }
}

function makeResponse(): FakeResponse {
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const response: FakeResponse = {
    status: 0,
    body: '',
    writeHead(status: number) {
      response.status = status;
      return response;
    },
    end(chunk?: string) {
      response.body = chunk ?? '';
      resolveDone();
      return response;
    },
  };
  (response as unknown as { done: Promise<void> }).done = done;
  return response;
}

async function call(
  handler: (request: WebRequestLike, response: WebResponseLike) => void,
  options: { method: string; url: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = makeResponse();
  handler(new FakeRequest(options), response);
  await (response as unknown as { done: Promise<void> }).done;
  return { status: response.status, json: JSON.parse(response.body) as Record<string, unknown> };
}

describe('设置页 API 契约', () => {
  it('一次 prefix 注册在插件命名空间下', () => {
    const { runtime } = fakeRuntime();
    const routes: Array<{ kind: string; path: string; handler: unknown }> = [];
    const dispose = registerApi({
      runtime,
      webServer: {
        register: (route: { kind: string; path: string; handler: unknown }) => {
          routes.push(route);
          return () => undefined;
        },
      },
    });
    expect(routes).toHaveLength(1);
    expect(routes[0]?.kind).toBe('prefix');
    expect(routes[0]?.path).toBe(API_PREFIX);
    dispose();
  });

  it('跨源请求被拒绝（防跨站写配置/密钥）', async () => {
    const { runtime } = fakeRuntime();
    const routes: Array<{ handler: (request: WebRequestLike, response: WebResponseLike) => void }> = [];
    registerApi({
      runtime,
      webServer: {
        register: (route: { handler: (request: WebRequestLike, response: WebResponseLike) => void }) => {
          routes.push(route);
          return () => undefined;
        },
      },
    });
    const result = await call(routes[0]!.handler, {
      method: 'POST',
      url: `${API_PREFIX}/config`,
      headers: { host: '127.0.0.1:60271', origin: 'https://evil.example.com', 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'engine', value: 'off' }),
    });
    expect(result.status).toBe(403);
    expect(result.json.error).toBe('cross_origin');
  });

  it('非 JSON 的 POST 被拒绝', async () => {
    const { runtime } = fakeRuntime();
    const routes: Array<{ handler: (request: WebRequestLike, response: WebResponseLike) => void }> = [];
    registerApi({ runtime, webServer: { register: (route) => { routes.push(route as never); return () => undefined; } } });
    const result = await call(routes[0]!.handler, {
      method: 'POST',
      url: `${API_PREFIX}/config`,
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(result.status).toBe(415);
    expect(result.json.error).toBe('json_required');
  });

  it('字段白名单外/非法值被拒绝，合法值落成嵌套 patch', async () => {
    const { runtime, patches } = fakeRuntime();
    const routes: Array<{ handler: (request: WebRequestLike, response: WebResponseLike) => void }> = [];
    registerApi({ runtime, webServer: { register: (route) => { routes.push(route as never); return () => undefined; } } });
    const handler = routes[0]!.handler;

    const bad = await call(handler, {
      method: 'POST',
      url: `${API_PREFIX}/config`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'rm -rf', value: 1 }),
    });
    expect(bad.status).toBe(400);

    const badValue = await call(handler, {
      method: 'POST',
      url: `${API_PREFIX}/config`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'engine', value: 'turbo' }),
    });
    expect(badValue.status).toBe(400);

    const good = await call(handler, {
      method: 'POST',
      url: `${API_PREFIX}/config`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ field: 'engine', value: 'local' }),
    });
    expect(good.status).toBe(200);
    expect(patches).toEqual([{ audio: { asr: { engine: 'local' } } }]);
  });

  it('GET /status 返回结构与插件页所需字段', async () => {
    const { runtime } = fakeRuntime();
    const routes: Array<{ handler: (request: WebRequestLike, response: WebResponseLike) => void }> = [];
    registerApi({ runtime, webServer: { register: (route) => { routes.push(route as never); return () => undefined; } } });
    const result = await call(routes[0]!.handler, {
      method: 'GET',
      url: `${API_PREFIX}/status`,
      headers: { host: '127.0.0.1:60271' },
    });
    expect(result.status).toBe(200);
    const data = result.json.data as Record<string, unknown>;
    expect(data.modelId).toBe('small-q5_1');
    expect(Array.isArray(data.presets)).toBe(true);
    expect(Array.isArray(data.engines)).toBe(true);
    expect((data.ffmpeg as Record<string, unknown>).available).toBeTypeOf('boolean');
  });

  it('未知路由与不支持的方法有明确错误码', async () => {
    const { runtime } = fakeRuntime();
    const routes: Array<{ handler: (request: WebRequestLike, response: WebResponseLike) => void }> = [];
    registerApi({ runtime, webServer: { register: (route) => { routes.push(route as never); return () => undefined; } } });
    const notFound = await call(routes[0]!.handler, {
      method: 'GET',
      url: `${API_PREFIX}/nope`,
      headers: { host: '127.0.0.1:60271' },
    });
    expect(notFound.status).toBe(404);

    const wrongMethod = await call(routes[0]!.handler, {
      method: 'DELETE',
      url: `${API_PREFIX}/status`,
      headers: { host: '127.0.0.1:60271' },
    });
    expect(wrongMethod.status).toBe(405);
  });
});
