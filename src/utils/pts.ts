/**
 * PTS 与时间参数工具。全部时间判定以 PTS 毫秒为唯一标尺（契约 5）。
 */

/** 数值钳制到闭区间 [min, max]；NaN 归 min。 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * 秒（number 或 ffprobe 输出的十进制字符串）→ 毫秒整数。
 * 字符串兼容两种形态：十进制秒（"2.966666"）与时钟 HH:MM:SS[.mmm]
 * （Matroska tags.DURATION 即此时钟形态，parseFloat 会在 ':' 处截断得 0）。
 */
export function secondsToMs(seconds: number | string | undefined | null): number {
  if (typeof seconds === 'string') {
    const clock = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d+))?\s*$/.exec(seconds);
    if (clock) {
      const base = ((Number(clock[1]) * 60 + Number(clock[2])) * 60 + Number(clock[3])) * 1000;
      const frac = clock[4] ?? '';
      return base + Number(frac.slice(0, 3).padEnd(3, '0'));
    }
  }
  const value = typeof seconds === 'string' ? Number.parseFloat(seconds) : seconds;
  if (value === undefined || value === null || !Number.isFinite(value)) return 0;
  return Math.round(value * 1000);
}

/** 有理数帧率字符串（如 "30000/1001"、"30/1"、"30"）→ 帧率数值；非法输入返回 0。 */
export function parseRational(input: string | undefined | null): number {
  if (!input) return 0;
  const trimmed = input.trim();
  if (trimmed === '') return 0;
  const slashIndex = trimmed.indexOf('/');
  let numerator: number;
  let denominator: number;
  if (slashIndex === -1) {
    numerator = Number.parseFloat(trimmed);
    denominator = 1;
  } else {
    numerator = Number.parseFloat(trimmed.slice(0, slashIndex));
    denominator = Number.parseFloat(trimmed.slice(slashIndex + 1));
  }
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * last_pts_ms 保守估算路径（契约 3）：
 * duration_ms − 2 × (1000 / avg_fps)，覆盖 VFR 场景下的常见末帧间隔；
 * 结果钳制到 [0, duration_ms]。
 */
export function estimateLastPtsMs(durationMs: number, avgFps: number): number {
  if (avgFps <= 0) return clamp(durationMs, 0, durationMs);
  const frameGapMs = 1000 / avgFps;
  return clamp(Math.round(durationMs - 2 * frameGapMs), 0, durationMs);
}
