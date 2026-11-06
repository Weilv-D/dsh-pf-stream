/**
 * 「点一下验证」：用一段 1 秒 440Hz 的合成音跑真实转写链路。
 *
 * 为什么不用 ping/模型列表：初学者关心的是「这台机器能不能出字」，
 * 只有真正跑一次引擎才能回答。合成音没有语音内容，但足以证明
 * 进程能启动、模型能加载、网络与密钥可用。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AsrSettings } from '../audio/types.js';
import { transcriptionUrl } from '../audio/asrProviders.js';

/** 16kHz / 16bit / 单声道 WAV，1 秒 440Hz 正弦。 */
export function toneWav(seconds = 1, sampleRate = 16_000): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.2 * 32767);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

export interface VerifyResult {
  ok: boolean;
  kind: 'cloud' | 'local';
  latencyMs: number;
  /** 云端返回的文本（几乎总是空）；本地不返回。 */
  text: string | null;
  message: string;
}

function runCaptured(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stderr: string; spawnError: Error | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ code: null, stderr: '', spawnError: null, timedOut: true });
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stderr: '', spawnError: error, timedOut: false });
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stderr, spawnError: null, timedOut: false });
    });
  });
}

/** 本地：跑一次 1 秒音频，能产出 SRT（哪怕空）即算通过。 */
export async function verifyLocal(settings: AsrSettings, timeoutMs = 60_000): Promise<VerifyResult> {
  const started = Date.now();
  if (settings.model === null) {
    return { ok: false, kind: 'local', latencyMs: 0, text: null, message: '没有可执行文件' };
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'pf-verify-'));
  try {
    const audio = path.join(dir, 'probe.wav');
    await writeFile(audio, toneWav());
    const args = (settings.args ?? []).map((token) =>
      token
        .split('{audio}').join(audio)
        .split('{dir}').join(dir)
        .split('{outbase}').join(path.join(dir, 'chunk'))
        .split('{out}').join(path.join(dir, 'cli-out.txt')),
    );
    if (!args.includes(audio)) args.push(audio);
    const result = await runCaptured(settings.model, args, timeoutMs);
    const latencyMs = Date.now() - started;
    if (result.spawnError !== null) {
      return {
        ok: false,
        kind: 'local',
        latencyMs,
        text: null,
        message: `无法启动：${result.spawnError.message}`,
      };
    }
    if (result.timedOut) {
      return {
        ok: false,
        kind: 'local',
        latencyMs,
        text: null,
        message: `验证超时（超过 ${timeoutMs}ms）；本地引擎首次运行需要加载模型，可在高级配置调大 timeoutMs`,
      };
    }
    if (result.code !== 0) {
      const tail = result.stderr.trim().split(/\r?\n/).slice(-3).join(' / ');
      return {
        ok: false,
        kind: 'local',
        latencyMs,
        text: null,
        message: `引擎退出码 ${String(result.code)}${tail === '' ? '' : `：${tail}`}`,
      };
    }
    return { ok: true, kind: 'local', latencyMs, text: null, message: '本地引擎可用' };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 云端：把同一段音频发给端点的 /audio/transcriptions。 */
export async function verifyCloud(settings: AsrSettings, timeoutMs = 20_000): Promise<VerifyResult> {
  const started = Date.now();
  if (settings.baseUrl === null || settings.apiKey === null) {
    return { ok: false, kind: 'cloud', latencyMs: 0, text: null, message: '缺少端点或密钥' };
  }
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(toneWav())], { type: 'audio/wav' }), 'probe.wav');
  form.append('model', settings.model ?? 'whisper-1');
  form.append('response_format', 'json');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(transcriptionUrl(settings.baseUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: 'cloud', latencyMs, text: null, message: '密钥被拒绝（401/403）' };
    }
    if (response.status === 402) {
      return { ok: false, kind: 'cloud', latencyMs, text: null, message: '账户余额不足（402）' };
    }
    if (response.status === 404) {
      return { ok: false, kind: 'cloud', latencyMs, text: null, message: '端点不存在（404），检查服务地址' };
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 200);
      return {
        ok: false,
        kind: 'cloud',
        latencyMs,
        text: null,
        message: `HTTP ${response.status}${body === '' ? '' : `：${body}`}`,
      };
    }
    const doc = (await response.json().catch(() => ({}))) as { text?: string };
    return {
      ok: true,
      kind: 'cloud',
      latencyMs,
      text: doc.text ?? '',
      message: '密钥与端点可用',
    };
  } catch (error) {
    return {
      ok: false,
      kind: 'cloud',
      latencyMs: Date.now() - started,
      text: null,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}
