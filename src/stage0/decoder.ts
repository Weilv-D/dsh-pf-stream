/**
 * Stage 0 —— 双模解码调度（契约 3）。
 *
 * - seek_points（定点寻址）：目标 PTS 排序去重后逐点 `ffmpeg -ss <pts> -i <file> -frames:v 1`
 *   关键帧跳跃 + 精解码，全分辨率（保障 OCR 级细节）；
 * - 批量退化：目标数 ≥32 且平均间隔 ≤2s 时，排序后单遍区间解码摊薄寻址开销；
 * - 空帧回退：解码端空输出时回退复用最后一个有效解码帧（契约 3）；
 * - 解码输出天然处于显示坐标系（ffmpeg 默认 autorotate）。
 *
 * decodeRangeStreaming 为单遍流式消费（契约 3：每帧解码后同步派生感知图，
 * 当场裁剪缩放入队并释放原图；await onFrame 期间 stdout 异步迭代自动背压）。
 */

import { spawn } from 'node:child_process';
import { PfStreamError } from '../errors.js';
import type { RgbImage } from '../utils/image.js';
import { execFile } from './ffmpeg.js';

export interface DecodePointOptions {
  ffmpegPath: string;
  /** ffprobe 路径（缺省时由 ffmpegPath 同目录派生）。 */
  ffprobePath?: string | undefined;
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
  // 截断帧（0 < 长度 < frameBytes）按空帧处理，交由回退链兜底。
  if (stdout.length < frameBytes) return null;
  return { width: options.displayWidth, height: options.displayHeight, data: stdout.subarray(0, frameBytes) };
}

export interface PtsIndexEntry {
  frameIndex: number;
  ptsMs: number;
}

/** 窗口帧 PTS 索引（ffprobe -show_frames，VFR 安全）。videoOrdinal 为主视频流序（probe.videoStreamIndex）。 */
export async function probePtsIndex(
  ffprobePath: string,
  videoPath: string,
  window0Ms: number,
  window1Ms: number,
  videoOrdinal = 0,
  signal?: AbortSignal | undefined,
): Promise<PtsIndexEntry[]> {
  const interval = `${(window0Ms / 1000).toFixed(3)}%${(window1Ms / 1000).toFixed(3)}`;
  const argv = [
    '-v', 'error',
    '-select_streams', `v:${videoOrdinal}`,
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
    const ms = Number.parseFloat(t) * 1000;
    // read_intervals 起点为关键帧回卷（pre-roll）：丢弃窗口外条目，
    // 保证与 ffmpeg 精确 -ss 的首帧对齐（VFR 安全，亚毫秒精度）。
    if (ms < window0Ms - 0.5 || ms > window1Ms + 0.5) continue;
    entries.push({ frameIndex: entries.length, ptsMs: ms });
  }
  return entries;
}

export interface RangeDecodeOptions extends DecodePointOptions {
  workMaxEdge?: number | undefined;
  /** 主视频流序（probe.videoStreamIndex；封面流存在时 v:0 是封面，必须显式指定）。 */
  videoStreamIndex?: number | undefined;
  /** 每次 ffmpeg 解码进程启动时回调（argv 快照），供单遍解码断言计数。 */
  onFfmpegSpawn?: ((argv: string[]) => void) | undefined;
}

async function probePtsIndexExec(
  options: RangeDecodeOptions,
  videoPath: string,
  w0: number,
  w1: number,
): Promise<PtsIndexEntry[]> {
  // ffprobe 显式配置优先；缺省时按与 ffmpeg 同目录约定派生
  const ffprobe = options.ffprobePath
    ?? options.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  return probePtsIndex(ffprobe, videoPath, w0, w1, options.videoStreamIndex ?? 0, options.signal);
}

/** 区间解码输出几何（workMaxEdge 等比上限）。 */
function rangeOutputGeometry(options: RangeDecodeOptions): {
  outW: number;
  outH: number;
  vf: string[];
} {
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
  return { outW, outH, vf };
}

function rangeArgv(
  videoPath: string,
  window0Ms: number,
  window1Ms: number,
  geometry: { outW: number; outH: number; vf: string[] },
): string[] {
  const durationSec = ((window1Ms - window0Ms) / 1000 + 1.0).toFixed(3);
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', (window0Ms / 1000).toFixed(3),
    '-i', videoPath,
    '-t', durationSec,
    '-an', '-sn', '-dn',
    '-fps_mode', 'passthrough',
    ...(geometry.vf.length > 0 ? ['-vf', geometry.vf.join(',')] : []),
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ];
}

export interface StreamDecodeResult {
  frameCount: number;
  /** 索引耗尽后按最近 PTS 钳制重对齐消费的解码裕量帧数（窗口外帧，PTS 钳到末帧）。 */
  realigned: number;
}

/**
 * 单遍流式区间解码：stdout 逐帧切片回调，原始字节不整体驻留。
 * onFrame 抛错时终止子进程并向上传播。
 */
export async function decodeRangeStreaming(
  videoPath: string,
  window0Ms: number,
  window1Ms: number,
  options: RangeDecodeOptions,
  onFrame: (image: RgbImage, ptsMs: number) => Promise<void> | void,
): Promise<StreamDecodeResult> {
  const index = await probePtsIndexExec(options, videoPath, window0Ms, window1Ms);
  if (index.length === 0) return { frameCount: 0, realigned: 0 };
  const geometry = rangeOutputGeometry(options);
  const argv = rangeArgv(videoPath, window0Ms, window1Ms, geometry);
  const frameBytes = geometry.outW * geometry.outH * 3;

  const child = spawn(options.ffmpegPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  options.onFfmpegSpawn?.(argv);
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrBytes < 64 * 1024) {
      stderrChunks.push(chunk);
      stderrBytes += chunk.length;
    }
  });

  let pending: Buffer | null = null;
  let frameIndex = 0;
  let realigned = 0;
  let killed = false;
  // 墙钟 30s 无帧推进告警（规格《六》§1）：解码器长时间无输出即终止并报错。
  const STALL_TIMEOUT_MS = 30_000;
  let lastFrameWallMs = Date.now();
  let stalled = false;
  const stallTimer = setInterval(() => {
    if (Date.now() - lastFrameWallMs > STALL_TIMEOUT_MS) {
      stalled = true;
      child.kill();
    }
  }, 1_000);

  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code) => resolveExit(code));
  });

  try {
    for await (const chunk of child.stdout!) {
      pending = pending ? Buffer.concat([pending, chunk as Buffer]) : (chunk as Buffer);
      while (pending && pending.length >= frameBytes) {
        const image: RgbImage = {
          width: geometry.outW,
          height: geometry.outH,
          data: pending.subarray(0, frameBytes),
        };
        if (frameIndex < index.length) {
          lastFrameWallMs = Date.now();
          await onFrame(image, index[frameIndex]!.ptsMs);
          lastFrameWallMs = Date.now();
          frameIndex++;
        } else {
          // 索引耗尽：解码裕量帧（-t 窗口 +1s 产出）位于窗口之外，按最近 PTS 钳制
          // 重对齐消费（设计 R3 兜底），不产生新窗口 PTS；流式感知侧的 33.3ms 步长门
          // 会自然丢弃重复 PTS 帧。
          realigned++;
          await onFrame(image, index[index.length - 1]!.ptsMs);
          lastFrameWallMs = Date.now();
        }
        pending = pending.length > frameBytes ? pending.subarray(frameBytes) : null;
      }
      if (options.signal?.aborted) break;
    }
  } catch (error) {
    killed = true;
    child.kill();
    // 等待退出事件落定再抛（exited 可能因 spawn 'error' 而拒绝，吞掉以保留原始错误），
    // 避免进程退出途中抛出造成无人接住的拒绝。
    await exited.catch(() => undefined);
    throw error;
  } finally {
    clearInterval(stallTimer);
  }

  if (options.signal?.aborted && !killed) {
    child.kill();
    await exited;
    throw new PfStreamError('PFSTREAM_EXEC_ABORT', '解码已被调用方取消');
  }

  const code = await exited;
  if (stalled) {
    throw new PfStreamError(
      'PFSTREAM_DECODE_STALL',
      `解码连续 ${STALL_TIMEOUT_MS}ms 无帧推进，已终止（可能为损坏媒体或解码器阻塞）`,
    );
  }
  if (code !== 0 && !killed) {
    // 非零退出码代表真实失败（损坏流/参数错），即使已消费 realigned 裕量帧也如实报错：
    // 静默吞掉会把截短的窗口伪装成正常完成。
    const stderrTail = Buffer.concat(stderrChunks)
      .subarray(Math.max(0, stderrBytes - 2048))
      .toString('utf8');
    throw new PfStreamError(
      'PFSTREAM_EXEC_NONZERO',
      `ffmpeg 流式解码退出码 ${code}\nstderr 尾部：\n${stderrTail}`,
    );
  }
  return { frameCount: frameIndex, realigned };
}

/**
 * 空帧回退解码（契约 3）：优先目标 PTS，空帧依次回退
 * 调用方最后有效帧 → lastPtsMs → 半帧回退（PTS 毫秒取整进位会把
 * -ss 目标推到末帧之后，回退 4ms 覆盖至 120fps 栅格），仍空则报错。
 */
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
  if (ptsMs > 0) {
    const nudge = await decodePoint(videoPath, ptsMs - 4, options);
    if (nudge) return nudge;
  }
  throw new PfStreamError('PFSTREAM_DECODE_EMPTY', `时间点 ${ptsMs}ms 无可解码帧`);
}
