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
import { readFile } from 'node:fs/promises';
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

/**
 * 转写端点：接受 origin、origin/v1，以及用户直接粘贴的完整
 * `/v1/audio/transcriptions`，避免出现重复路径段。
 */
export function transcriptionUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (/\/audio\/transcriptions$/i.test(base)) return base;
  return /\/v1$/i.test(base) ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
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
  // 进入时已中止的 signal 不会再触发 abort 事件，显式触发一次
  if (signal?.aborted) onAbort();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function buildForm(input: AsrChunkInput, settings: AsrSettings, responseFormat: string): FormData {
  const form = new FormData();
  const ext =
    input.mimeType === 'audio/ogg' ? 'ogg' : input.mimeType === 'audio/wav' ? 'wav' : 'mp3';
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
      transcriptionUrl(settings.baseUrl),
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
  const doc = (await response.json().catch(() => {
    // 非法 JSON 若任其抛 SyntaxError 会绕过 AsrRequestError 契约，
    // 被路由层 catch{failed++} 吞成无诊断的静默块失败。
    throw new AsrRequestError('ASR 响应不是合法 JSON', 'ASR_BAD_RESPONSE');
  })) as VerboseJson;
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
      transcriptionUrl(settings.baseUrl),
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
  const doc = (await response.json().catch(() => {
    throw new AsrRequestError('ASR 响应不是合法 JSON', 'ASR_BAD_RESPONSE');
  })) as { text?: string };
  const text = (doc.text ?? '').trim();
  if (!text) return [];
  return [{ startMs: 0, endMs: input.endMs - input.startMs, text }];
}

/**
 * host_sensevoice：复用官方「语音输入」插件的 speechToText 服务。
 *
 * 官方 provider 只返回整块文本、没有段级时间戳；路由层把文本锚到块区间。
 * 服务未就绪/未安装时由引擎选择层拦截，这里只处理探测后仍失败的情况。
 */
export async function transcribeHostSpeech(
  input: AsrChunkInput,
  deps: AsrTranscribeDeps,
): Promise<RawSegment[]> {
  const { settings, signal } = deps;
  const service = settings.hostService;
  const providerId = settings.model;
  if (service === undefined || service === null) {
    throw new AsrRequestError('官方语音输入服务不可用', 'ASR_HOST_UNAVAILABLE');
  }
  if (!providerId) {
    throw new AsrRequestError('官方语音输入 provider 未指定', 'ASR_HOST_UNAVAILABLE');
  }
  let spec: unknown;
  try {
    const language = settings.language?.trim();
    spec = service.resolve({
      audio: input.bytes,
      providerId,
      ...(language === undefined || language === '' ? {} : { language }),
    });
  } catch (error) {
    throw new AsrRequestError(
      `官方语音输入无法解析音频：${(error as Error).message}`,
      'ASR_HOST_RESOLVE',
    );
  }
  const timeoutMs = Number.isFinite(settings.timeoutMs) && settings.timeoutMs > 0
    ? settings.timeoutMs
    : 120_000;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timeoutError = new AsrRequestError(`官方语音输入超过 ${timeoutMs}ms`, 'ASR_TIMEOUT');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });
  let transcript: { text?: string | undefined };
  try {
    transcript = await Promise.race([
      service.transcribe(spec, controller.signal),
      timeout,
    ]);
  } catch (error) {
    if (error === timeoutError) throw error;
    if (signal?.aborted) {
      throw new AsrRequestError('官方语音输入被取消', 'ASR_ABORT');
    }
    throw new AsrRequestError(
      `官方语音输入转写失败：${(error as Error).message}`,
      'ASR_HOST_TRANSCRIBE',
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  if (transcript === null || typeof transcript !== 'object') {
    throw new AsrRequestError('官方语音输入返回空结果', 'ASR_HOST_TRANSCRIBE');
  }
  const text = typeof transcript.text === 'string' ? transcript.text.trim() : '';
  if (text.length === 0) return [];
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
    // argv 模板：{audio}=音频路径 {out}=输出文件路径 {dir}=音频所在临时目录
    // {outbase}=输出基名（whisper.cpp 的 -of 用，产出 <base>.srt）；
    // 无 {audio} 令牌时音频路径追加在末尾
    const rawArgs = settings.args ?? [];
    const usesAudioToken = rawArgs.some((arg) => arg.includes('{audio}'));
    const outFile = rawArgs.some((arg) => arg.includes('{out}')) ? path.join(dir, 'cli-out.txt') : null;
    const outBase = path.join(dir, 'chunk');
    const usesOutBase = rawArgs.some((arg) => arg.includes('{outbase}'));
    const usesDir = rawArgs.some((arg) => arg.includes('{dir}'));
    const argv = rawArgs.map((arg) =>
      arg
        .split('{audio}').join(audioFile)
        .split('{outbase}').join(outBase)
        .split('{out}').join(outFile ?? path.join(dir, 'cli-out.txt'))
        .split('{dir}').join(dir),
    );
    if (!usesAudioToken) argv.push(audioFile);
    const stdout = await new Promise<string>((resolve, reject) => {
      // PYTHONUTF8：Python 系 CLI 在 GBK 控制台输出中文会抛 UnicodeEncodeError
      const child = spawn(exe, argv, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, PYTHONUTF8: '1' } });
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
    // 契约：args 含 {out}/{outbase}/{dir} 令牌时结果按文件产物优先（CLI 的 stdout 可能只有进度杂讯）；
    // 无令牌的零参 CLI 以 stdout 为主，音频同目录产物兜底
    const expectsArtifacts = outFile !== null || usesOutBase || usesDir;
    let content = '';
    const readArtifact = async (): Promise<string> => {
      const candidates = [outFile, path.join(dir, 'chunk.srt'), path.join(dir, 'chunk.vtt'), path.join(dir, 'chunk.txt'), path.join(dir, 'chunk.json')];
      for (const c of candidates) {
        if (c === null) continue;
        const t = await readFile(c, 'utf8').catch(() => '');
        if (t.trim().length > 0) return t;
      }
      return '';
    };
    if (expectsArtifacts) {
      content = (await readArtifact()) || stdout;
    } else {
      content = stdout.trim().length > 0 ? stdout : await readArtifact();
    }
    return parseCliOutput(content, input.endMs - input.startMs);
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
    case 'host_sensevoice':
      return transcribeHostSpeech(input, deps);
    default:
      throw new AsrRequestError(`未知 provider：${deps.settings.provider}`, 'ASR_PROVIDER');
  }
}
