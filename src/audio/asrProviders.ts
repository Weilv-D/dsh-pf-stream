/**
 * Stage A2 —— ASR provider 适配。
 *
 * - openai_verbose：/v1/audio/transcriptions + verbose_json（段级时间戳）；
 *   服务端拒绝 verbose_json（sensevoice 等兼容端）时回退 openai_basic 语义；
 * - openai_basic：json 整块文本，时间戳由路由层按切分区间锚定；
 * - local_cli：本地命令行转写器，stdout 支持 JSON / SRT / 纯文本三种形态。
 *
 * 网络/进程失败一律抛 AsrRequestError；路由层按块失败计数，不外抛。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseSrt } from './subtitleExtractor.js';
import type { AsrSettings, TranscriptSegment } from './types.js';

export class AsrRequestError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

export interface AsrChunkInput {
  /** 绝对 PTS 起点（毫秒）——路由层锚定用。 */
  startMs: number;
  endMs: number;
  bytes: Buffer;
  mimeType: string;
}

export interface RawSegment {
  /** 相对块起点的毫秒。 */
  startMs: number;
  endMs: number;
  text: string;
  noSpeechProb?: number | undefined;
  avgLogprob?: number | undefined;
  compressionRatio?: number | undefined;
}

export interface AsrTranscribeDeps {
  settings: AsrSettings;
  signal?: AbortSignal | undefined;
}

interface VerboseJson {
  text?: string;
  language?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    no_speech_prob?: number;
    avg_logprob?: number;
    compression_ratio?: number;
  }>;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`ASR 请求超过 ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function buildForm(input: AsrChunkInput, settings: AsrSettings, responseFormat: string): FormData {
  const form = new FormData();
  const ext = input.mimeType === 'audio/ogg' ? 'ogg' : 'mp3';
  form.append('file', new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), `chunk.${ext}`);
  form.append('model', settings.model ?? 'whisper-1');
  form.append('response_format', responseFormat);
  if (settings.language) form.append('language', settings.language);
  return form;
}

/** openai_verbose：段级时间戳（相对块起点）。 */
export async function transcribeVerbose(
  input: AsrChunkInput,
  deps: AsrTranscribeDeps,
): Promise<RawSegment[]> {
  const { settings, signal } = deps;
  if (!settings.baseUrl || !settings.apiKey) {
    throw new AsrRequestError('openai_verbose 需要 baseUrl 与 apiKey', 'ASR_NOT_CONFIGURED');
  }
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${normalizeBaseUrl(settings.baseUrl)}/v1/audio/transcriptions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}` },
        body: buildForm(input, settings, 'verbose_json'),
      },
      settings.timeoutMs,
      signal,
    );
  } catch (error) {
    throw new AsrRequestError(`ASR 网络请求失败：${(error as Error).message}`, 'ASR_NETWORK');
  }
  if (response.status === 400) {
    // 兼容端不支持 verbose_json：退 json（调用方按整块文本处理）
    throw new AsrRequestError('服务端拒绝 verbose_json', 'ASR_VERBOSE_REJECTED');
  }
  if (!response.ok) {
    throw new AsrRequestError(`ASR HTTP ${response.status}`, `ASR_HTTP_${response.status}`);
  }
  const doc = (await response.json()) as VerboseJson;
  const segments = (doc.segments ?? [])
    .filter((s) => typeof s.start === 'number' && typeof s.end === 'number' && (s.text ?? '').trim().length > 0)
    .map((s) => ({
      startMs: Math.round(s.start! * 1000),
      endMs: Math.round(s.end! * 1000),
      text: s.text!.trim(),
      noSpeechProb: s.no_speech_prob,
      avgLogprob: s.avg_logprob,
      compressionRatio: s.compression_ratio,
    }));
  if (segments.length === 0 && (doc.text ?? '').trim().length > 0) {
    return [{ startMs: 0, endMs: input.endMs - input.startMs, text: doc.text!.trim() }];
  }
  return segments;
}

/** openai_basic：整块文本（时间戳 = 块区间）。 */
export async function transcribeBasic(
  input: AsrChunkInput,
  deps: AsrTranscribeDeps,
): Promise<RawSegment[]> {
  const { settings, signal } = deps;
  if (!settings.baseUrl || !settings.apiKey) {
    throw new AsrRequestError('openai_basic 需要 baseUrl 与 apiKey', 'ASR_NOT_CONFIGURED');
  }
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${normalizeBaseUrl(settings.baseUrl)}/v1/audio/transcriptions`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${settings.apiKey}` },
        body: buildForm(input, settings, 'json'),
      },
      settings.timeoutMs,
      signal,
    );
  } catch (error) {
    throw new AsrRequestError(`ASR 网络请求失败：${(error as Error).message}`, 'ASR_NETWORK');
  }
  if (!response.ok) {
    throw new AsrRequestError(`ASR HTTP ${response.status}`, `ASR_HTTP_${response.status}`);
  }
  const doc = (await response.json()) as { text?: string };
  const text = (doc.text ?? '').trim();
  if (!text) return [];
  return [{ startMs: 0, endMs: input.endMs - input.startMs, text }];
}

interface CliJson {
  segments?: Array<{ start?: number | string; end?: number | string; text?: string }>;
  text?: string;
}

/**
 * local_cli：settings.model 为可执行文件；音频写临时文件后作为唯一参数。
 * stdout 依次尝试 JSON → SRT → 纯文本。
 */
export async function transcribeLocalCli(
  input: AsrChunkInput,
  deps: AsrTranscribeDeps,
  tempDir?: string,
): Promise<RawSegment[]> {
  const { settings, signal } = deps;
  const exe = settings.model;
  if (!exe) throw new AsrRequestError('local_cli 需要 asr.model 指定可执行文件', 'ASR_NOT_CONFIGURED');
  const dir = await mkdtemp(path.join(tempDir ?? tmpdir(), 'pfstream-asr-'));
  const audioFile = path.join(dir, 'chunk.mp3');
  try {
    await writeFile(audioFile, input.bytes);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(exe, [audioFile], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      let out = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new AsrRequestError(`local_cli 超过 ${settings.timeoutMs}ms`, 'ASR_TIMEOUT'));
      }, settings.timeoutMs);
      const onAbort = () => {
        child.kill();
        reject(new AsrRequestError('local_cli 被取消', 'ASR_ABORT'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new AsrRequestError(`无法启动 ${exe}：${e.message}`, 'ASR_SPAWN'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve(out);
        else reject(new AsrRequestError(`local_cli 退出码 ${code}`, 'ASR_NONZERO'));
      });
    });
    return parseCliOutput(stdout, input.endMs - input.startMs);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function parseCliOutput(stdout: string, chunkMs: number): RawSegment[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const doc = JSON.parse(trimmed) as CliJson;
    if (Array.isArray(doc.segments) && doc.segments.length > 0) {
      return doc.segments
        .filter((s) => (s.text ?? '').trim().length > 0)
        .map((s) => ({
          startMs: Math.round(Number(s.start ?? 0) * 1000),
          endMs: Math.round(Number(s.end ?? chunkMs / 1000) * 1000),
          text: s.text!.trim(),
        }));
    }
    if ((doc.text ?? '').trim().length > 0) {
      return [{ startMs: 0, endMs: chunkMs, text: doc.text!.trim() }];
    }
  } catch {
    // 非 JSON，继续按 SRT / 纯文本解析
  }
  if (trimmed.includes('-->')) {
    return parseSrt(trimmed, 'asr').map((s) => ({ startMs: s.startMs, endMs: s.endMs, text: s.text }));
  }
  return [{ startMs: 0, endMs: chunkMs, text: trimmed }];
}

/** provider 分派（锚定到绝对 PTS 由路由层完成）。 */
export async function transcribeChunk(
  input: AsrChunkInput,
  deps: AsrTranscribeDeps,
  tempDir?: string,
): Promise<RawSegment[]> {
  switch (deps.settings.provider) {
    case 'openai_verbose':
      return transcribeVerbose(input, deps);
    case 'openai_basic':
      return transcribeBasic(input, deps);
    case 'local_cli':
      return transcribeLocalCli(input, deps, tempDir);
    default:
      throw new AsrRequestError(`未知 provider：${deps.settings.provider}`, 'ASR_PROVIDER');
  }
}
