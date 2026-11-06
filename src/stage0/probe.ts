/**
 * Stage 0 媒体探测：元数据 + 旋转归一化 + 末帧 PTS 双路径（契约 2 / 契约 3）。
 *
 * - 旋转双源：side_data_list[].rotation（Display Matrix，ffprobe 归一化到
 *   [-90,180] 区间，如 270° 报告 -90）与旧式 tags.rotate；统一归一到
 *   {0,90,180,270}，90°/270° 时在元数据层交换宽高建立显示坐标系。
 * - last_pts_ms：优先 ffprobe 尾段逐帧探测（O(0.6s)），无帧输出时按
 *   duration_ms − 2×(1000/avg_fps) 保守估算（VFR 末帧间隔覆盖）。
 */

import { stat } from 'node:fs/promises';
import type { ProbeResult } from '../types.js';
import { PfStreamError } from '../errors.js';
import { execFile } from './ffmpeg.js';
import { clamp, estimateLastPtsMs, parseRational, secondsToMs } from '../utils/pts.js';

const PROBE_TIMEOUT_MS = 60_000;

/** ffprobe -show_format -show_streams 的 JSON 形状（仅声明消费的字段）。 */
export interface FfprobeJson {
  streams?: Array<{
    index?: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    duration?: string;
    channels?: number;
    tags?: Record<string, string>;
    disposition?: { attached_pic?: number } | undefined;
    side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
  }>;
  format?: {
    duration?: string;
    tags?: Record<string, string>;
  };
}

export interface ProbeVideoOptions {
  ffprobePath: string;
  signal?: AbortSignal | undefined;
}

/** 旋转角归一化到 {0, 90, 180, 270}；非法输入按 0 处理。 */
export function normalizeRotation(degrees: number | undefined | null): 0 | 90 | 180 | 270 {
  if (typeof degrees !== 'number' || !Number.isFinite(degrees)) return 0;
  const normalized = ((Math.round(degrees) % 360) + 360) % 360;
  if (normalized === 90) return 90;
  if (normalized === 180) return 180;
  if (normalized === 270) return 270;
  return 0;
}

/** 双源解析旋转角：Display Matrix 优先，旧式 tags.rotate 次之。 */
export function extractRotation(stream: NonNullable<FfprobeJson['streams']>[number]): 0 | 90 | 180 | 270 {
  const displayMatrix = (stream.side_data_list ?? []).find(
    (side) => side.side_data_type === 'Display Matrix' && typeof side.rotation === 'number',
  );
  if (displayMatrix) return normalizeRotation(displayMatrix.rotation);
  const rotateTag = stream.tags?.['rotate'];
  if (rotateTag !== undefined) return normalizeRotation(Number.parseFloat(rotateTag));
  return 0;
}

/**
 * 由 ffprobe JSON 构造 ProbeResult（纯函数，供单测直接覆盖 tags.rotate 等合成输入）。
 * 视频流选择：跳过封面流（disposition.attached_pic=1，MP4 内嵌封面等），
 * 取首个真实视频流；全部为封面流时退回首轨（仅含封面的文件仍可探测元数据）。
 * duration 优先级：format.duration > 视频流 duration > format.tags.DURATION。
 */
export function buildProbeResult(raw: FfprobeJson): ProbeResult {
  const videoStreams = (raw.streams ?? []).filter((stream) => stream.codec_type === 'video');
  if (videoStreams.length === 0) {
    throw new PfStreamError('PFSTREAM_PROBE_NO_VIDEO', '容器内不存在视频流');
  }
  const mainIdx = videoStreams.findIndex((stream) => (stream.disposition?.attached_pic ?? 0) === 1 ? false : true);
  const videoOrdinal = mainIdx === -1 ? 0 : mainIdx;
  const video = videoStreams[videoOrdinal]!;

  const codedWidth = video.width ?? 0;
  const codedHeight = video.height ?? 0;
  const rotation = extractRotation(video);
  const swap = rotation === 90 || rotation === 270;

  const avgFps =
    parseRational(video.avg_frame_rate) > 0
      ? parseRational(video.avg_frame_rate)
      : parseRational(video.r_frame_rate);

  const durationMs =
    secondsToMs(raw.format?.duration) ||
    secondsToMs(video.duration) ||
    secondsToMs(raw.format?.tags?.['DURATION']);

  const audioStreams = (raw.streams ?? [])
    .filter((stream) => stream.codec_type === 'audio')
    .map((stream) => ({
      index: stream.index ?? 0,
      codec: stream.codec_name ?? 'unknown',
      ...(stream.channels !== undefined ? { channels: stream.channels } : {}),
    }));

  const subtitleStreams = (raw.streams ?? [])
    .filter((stream) => stream.codec_type === 'subtitle')
    .map((stream) => ({
      index: stream.index ?? 0,
      codec: stream.codec_name ?? 'unknown',
      ...(stream.tags?.['language'] !== undefined ? { language: stream.tags['language'] } : {}),
    }));

  return {
    codedWidth,
    codedHeight,
    displayWidth: swap ? codedHeight : codedWidth,
    displayHeight: swap ? codedWidth : codedHeight,
    rotation,
    durationMs,
    lastPtsMs: estimateLastPtsMs(durationMs, avgFps),
    avgFps,
    codec: video.codec_name ?? 'unknown',
    videoStreamIndex: videoOrdinal,
    audioStreams,
    subtitleStreams,
  };
}

interface FrameProbeJson {
  frames?: Array<{ pts_time?: string }>;
}

/**
 * 末帧 PTS 逐帧探测：durationMs 已知时只读容器尾段（0.6s 起读窗口 + 5s 余量）；
 * duration 三源全缺（=0）时退到百分比读窗（依赖解复用器内部时长，仍失败返回 null）。
 * 只探测主视频流（v:N，封面流跳过）。无帧输出或探测失败返回 null（调用方回退估算路径）。
 */
async function probeLastFramePtsMs(
  options: ProbeVideoOptions,
  durationMs: number,
  videoPath: string,
  videoOrdinal: number,
): Promise<number | null> {
  const intervals =
    durationMs > 0
      ? [`${Math.max(0, (durationMs - 600) / 1000).toFixed(3)}%+5`]
      : ['95%+30'];
  for (const interval of intervals) {
    const argv = [
      '-v', 'error',
      '-select_streams', `v:${videoOrdinal}`,
      '-show_frames',
      '-show_entries', 'frame=pts_time',
      '-of', 'json',
      '-read_intervals', interval,
      '-i', videoPath,
    ];
    let parsed: FrameProbeJson;
    try {
      const { stdout } = await execFile(options.ffprobePath, argv, {
        timeoutMs: PROBE_TIMEOUT_MS,
        signal: options.signal,
      });
      parsed = JSON.parse(stdout as string) as FrameProbeJson;
    } catch {
      continue;
    }
    const frames = parsed.frames ?? [];
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const ptsTime = frames[i]?.pts_time;
      if (ptsTime !== undefined) {
        const ms = secondsToMs(ptsTime);
        if (ms >= 0) return clamp(ms, 0, Math.max(durationMs, ms));
      }
    }
  }
  return null;
}

export async function probeVideo(videoPath: string, options: ProbeVideoOptions): Promise<ProbeResult> {
  try {
    const info = await stat(videoPath);
    if (!info.isFile()) {
      throw new PfStreamError('PFSTREAM_PROBE_NOT_FOUND', `路径不是常规文件：${videoPath}`);
    }
  } catch (error) {
    if (error instanceof PfStreamError) throw error;
    throw new PfStreamError('PFSTREAM_PROBE_NOT_FOUND', `文件不存在或不可访问：${videoPath}`);
  }

  let raw: FfprobeJson;
  try {
    const { stdout } = await execFile(
      options.ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', videoPath],
      { timeoutMs: PROBE_TIMEOUT_MS, signal: options.signal },
    );
    raw = JSON.parse(stdout as string) as FfprobeJson;
  } catch (error) {
    if (error instanceof PfStreamError && error.code === 'PFSTREAM_SPAWN_FAILED') throw error;
    throw new PfStreamError('PFSTREAM_PROBE_FAILED', (error as Error).message);
  }

  const result = buildProbeResult(raw);
  const lastFramePtsMs = await probeLastFramePtsMs(
    options,
    result.durationMs,
    videoPath,
    result.videoStreamIndex,
  );
  if (lastFramePtsMs !== null) result.lastPtsMs = lastFramePtsMs;
  // duration 三源全缺（=0）但逐帧探测拿到了末帧：以末帧 PTS 兜底时长。
  // 否则 estimateLastPtsMs(0,·)=0 → lastPtsMs=0 → 流式/检视窗口被钳成空窗。
  if (result.durationMs <= 0 && lastFramePtsMs !== null) result.durationMs = lastFramePtsMs;
  return result;
}
