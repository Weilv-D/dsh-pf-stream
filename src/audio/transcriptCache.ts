/**
 * 磁盘转写缓存。
 *
 * 键 = sha256(小写绝对路径 + mtime + size) + 引擎指纹（服务商/模型/语言）。
 * 视频变化或换引擎都会自动失效；密钥不参与指纹。
 * 值 = 已完成转写的区间列表（subtitle 提取为本地快操作，不走缓存）。
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AsrSettings, TranscriptSegment } from './types.js';

// v2：区间内独立编号（多区间拼接后 segId 冲突）；v3：全文档全局编号。
const CACHE_VERSION = 3;

export interface TranscriptInterval {
  startMs: number;
  endMs: number;
  source: 'asr';
  segments: TranscriptSegment[];
}

interface CacheDoc {
  version: number;
  fingerprint: string;
  intervals: TranscriptInterval[];
}

/** 视频指纹：路径小写 + mtime + size 的 SHA-256 前 32 位。 */
export async function videoFingerprint(videoPath: string): Promise<string> {
  const abs = path.resolve(videoPath);
  const st = await stat(abs);
  const digest = createHash('sha256')
    .update(abs.toLowerCase())
    .update(`|${Math.floor(st.mtimeMs)}|${st.size}`)
    .digest('hex');
  return digest.slice(0, 32);
}

/**
 * 引擎指纹：同一段音频用本地或云端得到的结果不同，缓存不能混用。
 * 只含影响转写结果的参数；apiKey 不参与（换密钥不失效）。
 */
export function engineFingerprint(settings: AsrSettings): string {
  const provider = settings.provider;
  const digest = createHash('sha256')
    .update(
      provider === 'host_sensevoice'
        ? `${provider}|${settings.model ?? ''}|${settings.modelLabel ?? ''}|${settings.language ?? ''}`
        : `${provider}|${settings.baseUrl ?? ''}|${settings.model ?? ''}|${settings.language}`,
    )
    .update(`|${(settings.args ?? []).join('\u0001')}`)
    .digest('hex');
  return digest.slice(0, 16);
}

function cacheFileFor(cacheDir: string, fingerprint: string): string {
  return path.join(cacheDir, `${fingerprint}.json`);
}

export async function readTranscriptCache(
  cacheDir: string,
  fingerprint: string,
): Promise<TranscriptInterval[] | null> {
  const file = cacheFileFor(cacheDir, fingerprint);
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(await readFile(file, 'utf8')) as CacheDoc;
    if (doc.version !== CACHE_VERSION || doc.fingerprint !== fingerprint) return null;
    if (!Array.isArray(doc.intervals)) return null;
    return doc.intervals;
  } catch {
    return null;
  }
}

/** 原子写入：先写 .tmp 再 rename。 */
export async function writeTranscriptCache(
  cacheDir: string,
  fingerprint: string,
  intervals: TranscriptInterval[],
): Promise<void> {
  const doc: CacheDoc = { version: CACHE_VERSION, fingerprint, intervals };
  await mkdir(cacheDir, { recursive: true });
  const file = cacheFileFor(cacheDir, fingerprint);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(doc), 'utf8');
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** 命中部分：与窗口相交的缓存区间按时间序拼接出的可用段。 */
export function cachedSegmentsFor(
  intervals: TranscriptInterval[],
  window: [number, number],
): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const it of intervals) {
    if (it.endMs <= window[0] || it.startMs >= window[1]) continue;
    for (const seg of it.segments) {
      if (seg.endMs <= window[0] || seg.startMs >= window[1]) continue;
      out.push(seg);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/**
 * 缺口计算：窗口减去已覆盖区间（允许 1s 重叠缝合）。
 * 返回需要重新转写的子窗口列表。
 */
export function missingRanges(
  intervals: TranscriptInterval[],
  window: [number, number],
  marginMs = 1000,
): Array<[number, number]> {
  const sorted = [...intervals]
    .filter((it) => it.endMs > window[0] && it.startMs < window[1])
    .sort((a, b) => a.startMs - b.startMs);
  const gaps: Array<[number, number]> = [];
  let cursor = window[0];
  for (const it of sorted) {
    const start = it.startMs - marginMs;
    const end = it.endMs + marginMs;
    if (start > cursor) gaps.push([cursor, Math.min(start, window[1])]);
    cursor = Math.max(cursor, end);
    if (cursor >= window[1]) break;
  }
  if (cursor < window[1]) gaps.push([cursor, window[1]]);
  return gaps.filter(([a, b]) => b - a > 50);
}

/** 新区间并入缓存文档（相邻重叠合并，段去重按起点）。 */
export function mergeInterval(
  intervals: TranscriptInterval[],
  addition: TranscriptInterval,
): TranscriptInterval[] {
  const merged = [...intervals, addition].sort((a, b) => a.startMs - b.startMs);
  const out: TranscriptInterval[] = [];
  for (const it of merged) {
    const last = out[out.length - 1];
    if (last && it.startMs <= last.endMs + 100) {
      const seen = new Set(last.segments.map((s) => s.startMs));
      last.endMs = Math.max(last.endMs, it.endMs);
      for (const seg of it.segments) if (!seen.has(seg.startMs)) last.segments.push(seg);
      last.segments.sort((a, b) => a.startMs - b.startMs);
    } else {
      out.push({ ...it, segments: [...it.segments] });
    }
  }
  return out;
}

/**
 * 全文档段全局重编号：segId 在整份缓存内唯一且随时间序单调递增。
 * mountSegments 以 segId 作为段身份键（owner 归属、(cont.) 副本判定），
 * 多区间拼接后区间内独立编号必然冲突（≥2 缓存区间命中同一窗口时归属错乱）。
 * 前置条件：intervals 按 startMs 有序（mergeInterval 的输出不变量），
 * 区间内 segments 亦按 startMs 有序。就地修改并返回入参。
 *
 * 跨调用注意（设计取舍，非缺陷）："全局唯一 + 时序单调"两条不变量在回溯
 * 插入下不可兼得——后补转写更早窗口时，先前调用已返回的 segId 会整体平移
 * （前向流式追加场景无漂移）。跨调用引用台词段请以时间戳为准，勿锚定 segId。
 */
export function renumberSegmentsGlobally(intervals: TranscriptInterval[]): TranscriptInterval[] {
  let seq = 0;
  for (const it of intervals) {
    for (const seg of it.segments) {
      seq += 1;
      seg.segId = seq;
    }
  }
  return intervals;
}
