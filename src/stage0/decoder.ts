/**
 * Stage 0 —— 双模解码调度（契约 3）。
 *
 * - seek_points（定点寻址）：目标 PTS 排序去重后逐点 `ffmpeg -ss <pts> -i <file> -frames:v 1`
 *   关键帧跳跃 + 精解码，全分辨率（保障 OCR 级细节）；
 * - 批量退化：目标数 ≥32 且平均间隔 ≤2s 时，排序后单遍区间解码摊薄寻址开销；
 * - 空帧回退：解码端空输出时回退复用最后一个有效解码帧（契约 3）；
 * - 解码输出天然处于显示坐标系（ffmpeg 默认 autorotate）。
 */

import { PfStreamError } from '../errors.js';
import type { RgbImage } from '../utils/image.js';
import { execFile } from './ffmpeg.js';

export interface DecodePointOptions {
  ffmpegPath: string;
  displayWidth: number;
  displayHeight: number;
  signal?: AbortSignal | undefined;
}

export type DecodePointFn = typeof decodePoint;

/** 单点定点解码。返回 null 表示该 PTS 无帧输出（空帧）。 */
export async function decodePoint(
  videoPath: string,
  ptsMs: number,
  options: DecodePointOptions,
): Promise<RgbImage | null> {
  const sec = (ptsMs / 1000).toFixed(3);
  const argv = [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', sec,
    '-i', videoPath,
    '-frames:v', '1',
    '-an', '-sn', '-dn',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ];
  const { stdout } = await execFile(options.ffmpegPath, argv, {
    signal: options.signal,
    encoding: 'buffer',
  });
  const frameBytes = options.displayWidth * options.displayHeight * 3;
  if (stdout.length === 0) return null;
  return { width: options.displayWidth, height: options.displayHeight, data: stdout.subarray(0, frameBytes) };
}

export interface PtsIndexEntry {
  frameIndex: number;
  ptsMs: number;
}

/** 窗口帧 PTS 索引（ffprobe -show_frames，VFR 安全）。 */
export async function probePtsIndex(
  ffprobePath: string,
  videoPath: string,
  window0Ms: number,
  window1Ms: number,
  signal?: AbortSignal | undefined,
): Promise<PtsIndexEntry[]> {
  const interval = `${(window0Ms / 1000).toFixed(3)}%${(window1Ms / 1000).toFixed(3)}`;
  const argv = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-read_intervals', interval,
    '-show_entries', 'frame=pts_time',
    '-of', 'json',
    videoPath,
  ];
  const { stdout } = await execFile(ffprobePath, argv, { signal, encoding: 'utf8' });
  const parsed = JSON.parse(stdout) as { frames?: Array<{ pts_time?: string }> };
  const entries: PtsIndexEntry[] = [];
  for (const f of parsed.frames ?? []) {
    const t = f.pts_time;
    if (t == null) continue;
    entries.push({ frameIndex: entries.length, ptsMs: Math.round(Number.parseFloat(t) * 1000) });
  }
  return entries;
}

export interface RangeDecodeOptions extends DecodePointOptions {
  workMaxEdge?: number | undefined;
}

/**
 * 区间单遍解码（批量定点退化路径与流式共用骨架）。
 * 返回帧序列（display 坐标系，全分辨率或受 workMaxEdge 上限的等比缩放）。
 */
export async function decodeRange(
  videoPath: string,
  window0Ms: number,
  window1Ms: number,
  options: RangeDecodeOptions,
  onFrame?: (frame: RgbImage, ptsMs: number) => void | Promise<void>,
): Promise<Array<{ ptsMs: number; image: RgbImage }>> {
  const index = await probePtsIndexExec(options, videoPath, window0Ms, window1Ms);
  if (index.length === 0) return [];
  const vf: string[] = [];
  let outW = options.displayWidth;
  let outH = options.displayHeight;
  const maxEdge = options.workMaxEdge ?? 0;
  if (maxEdge > 0 && Math.max(options.displayWidth, options.displayHeight) > maxEdge) {
    const k = maxEdge / Math.max(options.displayWidth, options.displayHeight);
    outW = Math.max(2, Math.round(options.displayWidth * k) & ~1);
    outH = Math.max(2, Math.round(options.displayHeight * k) & ~1);
    vf.push(`scale=${outW}:${outH}`);
  }
  const durationSec = ((window1Ms - window0Ms) / 1000 + 1.0).toFixed(3);
  const argv = [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', (window0Ms / 1000).toFixed(3),
    '-i', videoPath,
    '-t', durationSec,
    '-an', '-sn', '-dn',
    '-fps_mode', 'passthrough',
    ...(vf.length > 0 ? ['-vf', vf.join(',')] : []),
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ];
  const { stdout } = await execFile(options.ffmpegPath, argv, {
    signal: options.signal,
    encoding: 'buffer',
  });
  const frameBytes = outW * outH * 3;
  const frameCount = Math.floor(stdout.length / frameBytes);
  const frames: Array<{ ptsMs: number; image: RgbImage }> = [];
  for (let i = 0; i < frameCount; i++) {
    const ptsMs = index[Math.min(i, index.length - 1)]!.ptsMs;
    const image: RgbImage = {
      width: outW,
      height: outH,
      data: stdout.subarray(i * frameBytes, (i + 1) * frameBytes),
    };
    frames.push({ ptsMs, image });
    await onFrame?.(image, ptsMs);
  }
  return frames;
}

async function probePtsIndexExec(
  options: RangeDecodeOptions,
  videoPath: string,
  w0: number,
  w1: number,
): Promise<PtsIndexEntry[]> {
  // ffprobe 路径与 ffmpeg 同目录约定：入口适配层保证成对解析
  const ffprobe = options.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  return probePtsIndex(ffprobe, videoPath, w0, w1, options.signal);
}

/** 空帧回退解码：优先目标 PTS，空帧回退 lastPts，仍空则报错。 */
export async function decodePointWithFallback(
  videoPath: string,
  ptsMs: number,
  lastPtsMs: number,
  options: DecodePointOptions,
  lastValid?: RgbImage | null,
): Promise<RgbImage> {
  const direct = await decodePoint(videoPath, ptsMs, options);
  if (direct) return direct;
  if (lastValid) return lastValid;
  if (ptsMs !== lastPtsMs) {
    const fallback = await decodePoint(videoPath, lastPtsMs, options);
    if (fallback) return fallback;
  }
  throw new PfStreamError('PFSTREAM_DECODE_EMPTY', `时间点 ${ptsMs}ms 无可解码帧`);
}
