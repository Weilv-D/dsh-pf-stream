/**
 * Stage A1 —— 声学 VAD（silencedetect + astats）与切分规划。
 *
 * silencedetect=noise=-35dB:d=0.4 提取静音区间；astats(reset=0) 取整窗
 * RMS/峰值电平。静音占比 ≥95% 或峰值 < -45dBFS 判定整窗无语音（短路）。
 * 长窗口按 VAD 谷底在 [45s, 75s] 弹性切分；无谷底可用时 60s 硬切。
 */

import { execFile } from '../stage0/ffmpeg.js';
import type { VadResult } from './types.js';

const SILENCE_NOISE_DB = -35;
const SILENCE_MIN_DURATION_S = 0.4;
export const SILENT_ACTIVE_RATIO_MAX = 0.05;
export const SILENT_PEAK_DB_MIN = -45;
const MIN_ISLAND_MS = 200;

export interface VadScanOptions {
  ffmpegPath: string;
  signal?: AbortSignal | undefined;
}

/**
 * 窗口声学扫描（-ss 前置输入寻址；PTS 相对窗口起点换算为绝对 PTS）。
 * 解析失败时返回 null（调用方按无 VAD 信息继续，不短路）。
 */
export async function scanVad(
  videoPath: string,
  window: [number, number],
  options: VadScanOptions,
): Promise<VadResult | null> {
  const [w0, w1] = window;
  const durationS = (w1 - w0) / 1000;
  let stderr: string;
  try {
    const result = await execFile(
      options.ffmpegPath,
      [
        '-nostdin',
        '-ss', (w0 / 1000).toFixed(3),
        '-t', durationS.toFixed(3),
        '-i', videoPath,
        '-vn', '-map', '0:a:0',
        '-af', `silencedetect=noise=${SILENCE_NOISE_DB}dB:d=${SILENCE_MIN_DURATION_S},astats=reset=0`,
        '-f', 'null', '-',
      ],
      { encoding: 'utf8', timeoutMs: 120_000, signal: options.signal },
    );
    stderr = result.stderr;
  } catch {
    return null;
  }

  const silences: Array<[number, number]> = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const sm = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (sm) {
      pendingStart = Math.max(0, Number(sm[1]));
      continue;
    }
    const em = /silence_end:\s*([\d.]+)/.exec(line);
    if (em && pendingStart !== null) {
      silences.push([w0 + pendingStart * 1000, w0 + Number(em[1]) * 1000]);
      pendingStart = null;
    }
  }
  if (pendingStart !== null) {
    silences.push([w0 + pendingStart * 1000, w1]); // 尾部静音延至窗口末
  }

  const rmsMatch = /RMS level dB:\s*(-?[\d.]+|-?inf)/.exec(stderr);
  const peakMatch = /Peak level dB:\s*(-?[\d.]+|-?inf)/.exec(stderr);
  const toDb = (raw: string | undefined): number | null => {
    if (raw === undefined) return null;
    if (raw === '-inf') return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const rmsDb = toDb(rmsMatch?.[1]);
  const peakDb = toDb(peakMatch?.[1]);

  const islands = complement(silences, window).filter(([a, b]) => b - a >= MIN_ISLAND_MS);
  const speechMs = islands.reduce((acc, [a, b]) => acc + (b - a), 0);
  return {
    silence: silences,
    islands,
    rmsDb,
    peakDb,
    activeRatio: w1 > w0 ? speechMs / (w1 - w0) : 0,
  };
}

/** 整窗无语音判定（静音占比 ≥95% 或峰值 < -45dBFS）。 */
export function isSilentWindow(vad: VadResult | null): boolean {
  if (vad === null) return false;
  if (vad.peakDb !== null && vad.peakDb < SILENT_PEAK_DB_MIN) return true;
  return vad.activeRatio < SILENT_ACTIVE_RATIO_MAX;
}

function complement(silences: Array<[number, number]>, window: [number, number]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let cursor = window[0];
  for (const [a, b] of silences) {
    if (a > cursor) out.push([cursor, Math.min(a, window[1])]);
    cursor = Math.max(cursor, b);
    if (cursor >= window[1]) break;
  }
  if (cursor < window[1]) out.push([cursor, window[1]]);
  return out;
}

export interface ChunkPlanOptions {
  /** 切分窗口下限（毫秒）。 */
  minMs: number;
  /** 切分窗口上限（毫秒）。 */
  maxMs: number;
  /** 无谷底时的硬切长度（毫秒）。 */
  hardMs: number;
}

export const DEFAULT_CHUNK_PLAN: ChunkPlanOptions = { minMs: 45_000, maxMs: 75_000, hardMs: 60_000 };

/**
 * 带时间戳 provider 的切分：谷底优先（取 [min, max] 内最深静音的中点），
 * 否则 hardMs 硬切。切点落在静音中点，句子不被腰斩。
 */
export function planChunks(
  window: [number, number],
  vad: VadResult | null,
  options: ChunkPlanOptions = DEFAULT_CHUNK_PLAN,
): Array<[number, number]> {
  const [w0, w1] = window;
  if (w1 - w0 <= options.maxMs) return [[w0, w1]];
  const chunks: Array<[number, number]> = [];
  let start = w0;
  while (start < w1) {
    if (w1 - start <= options.maxMs) {
      chunks.push([start, w1]);
      break;
    }
    const lo = start + options.minMs;
    const hi = start + options.maxMs;
    let cut = start + options.hardMs;
    if (vad) {
      let deepest = -1;
      for (const [a, b] of vad.silence) {
        const s = Math.max(a, lo);
        const e = Math.min(b, hi);
        if (e > s && e - s > deepest) {
          deepest = e - s;
          cut = Math.round((s + e) / 2);
        }
      }
    }
    cut = Math.min(cut, hi);
    chunks.push([start, cut]);
    start = cut;
  }
  return chunks;
}

/** 无时间戳 provider（openai_basic）的切分：语音岛直切，>30s 的岛硬切。 */
export function planIslandChunks(
  window: [number, number],
  vad: VadResult | null,
  maxIslandMs = 30_000,
): Array<[number, number]> {
  const islands = vad ? vad.islands.filter(([a, b]) => b > window[0] && a < window[1]) : [];
  if (islands.length === 0) return window[1] > window[0] ? [[window[0], window[1]]] : [];
  const chunks: Array<[number, number]> = [];
  for (const [a, b] of islands) {
    const s = Math.max(a, window[0]);
    const e = Math.min(b, window[1]);
    if (e <= s) continue;
    if (e - s <= maxIslandMs) {
      chunks.push([s, e]);
      continue;
    }
    for (let t = s; t < e; t += maxIslandMs) {
      chunks.push([t, Math.min(t + maxIslandMs, e)]);
    }
  }
  return chunks;
}

/**
 * host provider 的切分：优先语音岛，最多 15s。
 *
 * 官方 provider 只返回整块文本；块越短，块级时间戳越接近真实语音段。
 * 没有 VAD 岛时 planIslandChunks 会返回整窗，因此这里必须再硬切，
 * 避免长窗口超过 provider 的 4MiB WAV 上限。
 */
export function planHostChunks(
  window: [number, number],
  vad: VadResult | null,
  maxChunkMs = 15_000,
): Array<[number, number]> {
  const base = planIslandChunks(window, vad, maxChunkMs);
  const out: Array<[number, number]> = [];
  for (const [start, end] of base) {
    if (end - start <= maxChunkMs) {
      out.push([start, end]);
      continue;
    }
    for (let t = start; t < end; t += maxChunkMs) {
      out.push([t, Math.min(t + maxChunkMs, end)]);
    }
  }
  return out;
}

/**
 * 官方 speechToText 要求 canonical 44 字节 WAV 头：`fmt ` 在 12、`data` 在 36。
 * ffmpeg 写管道时长度字段是 0xFFFFFFFF；源音频带 metadata 时还会插入 LIST 块，
 * 使 `data` 偏移到 36 之后。这里统一重建成 canonical 头，丢掉 LIST 等附加块。
 */
export function canonicalizeWav(bytes: Buffer): Buffer {
  if (bytes.length < 44) return bytes;
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return bytes;
  }
  let offset = 12;
  let fmt: Buffer | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'fmt ' && size === 16) {
      fmt = bytes.subarray(offset + 8, offset + 24);
    }
    if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = size === 0xffffffff ? bytes.length - dataOffset : Math.min(size, bytes.length - dataOffset);
      break;
    }
    if (size === 0xffffffff) break;
    offset += 8 + size + (size & 1);
  }
  if (!fmt || dataOffset < 0 || dataSize < 0) return bytes;
  if (
    dataOffset === 44 &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.readUInt32LE(40) === dataSize
  ) {
    return bytes;
  }
  const out = Buffer.alloc(44 + dataSize);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + dataSize, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  fmt.copy(out, 20);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(dataSize, 40);
  bytes.copy(out, 44, dataOffset, dataOffset + dataSize);
  return out;
}

/**
 * 切片音频编码（16kHz 单声道；mp3 = libmp3lame -q:a 6，opus = libopus 24k，
 * wav = 16-bit PCM）。
 * 返回 {bytes, mimeType}；失败抛错由路由层按块失败处理。
 */
export async function sliceAudio(
  videoPath: string,
  range: [number, number],
  codec: 'mp3' | 'opus' | 'wav',
  options: VadScanOptions,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const [start, end] = range;
  const codecArgs =
    codec === 'mp3'
      ? ['-c:a', 'libmp3lame', '-q:a', '6', '-f', 'mp3']
      : codec === 'wav'
        ? ['-map_metadata', '-1', '-c:a', 'pcm_s16le', '-fflags', '+bitexact', '-f', 'wav']
        : ['-c:a', 'libopus', '-b:a', '24k', '-f', 'ogg'];
  const { stdout } = await execFile(
    options.ffmpegPath,
    [
      '-nostdin',
      '-ss', (start / 1000).toFixed(3),
      '-t', ((end - start) / 1000).toFixed(3),
      '-i', videoPath,
      '-vn', '-map', '0:a:0',
      '-ac', '1', '-ar', '16000',
      ...codecArgs,
      '-',
    ],
    { encoding: 'buffer', timeoutMs: 120_000, signal: options.signal },
  );
  return {
    bytes: codec === 'wav' ? canonicalizeWav(stdout) : stdout,
    mimeType: codec === 'mp3' ? 'audio/mpeg' : codec === 'wav' ? 'audio/wav' : 'audio/ogg',
  };
}
