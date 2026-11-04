/**
 * 契约 1/2/4 —— 视窗归一化（显示坐标系）。
 *
 * 规则（《四、采样逻辑…》§3 与契约 4 四步归一化）：
 * - roi_hint 或运动质心 → 1:1 正方形视窗（边长 = min(源短边向下取整, 包络目标区向上取整) 的 42 倍数，硬下限 84），
 *   缩放后 100% 填满槽位，零灰边；
 * - 全局/ full_frame → 等比内接 + 内容宽高量化到 42 倍数，居中灰补边（偏置对齐 42 网格）；
 * - 短边 ≥84 为硬约束（面积预算为软约束）；
 * - 源域外扩优先；外扩受物理边界限制仍不足 → 内容级中性灰补边并置 pad_overflow。
 */

import type { RoiHint } from '../types.js';
import { PAD_GRAY, bilinearResize, cropWithGrayFallback, type RgbImage } from '../utils/image.js';

/** 超像素模数。 */
export const SUPERPIXEL = 42;
/** 有效短边硬下限（2 个超像素步长）。 */
export const MIN_SHORT_SIDE = 84;

export type SlotKind = 'P' | 'F';

export interface ViewportPlan {
  /** 源视频显示坐标系采样区域 [x, y, w, h]（w/h 亦为 42 倍数）。 */
  sourceCropBbox: [number, number, number, number];
  /** 目标内容宽高（42 倍数；RoI 路径等于槽位边长）。 */
  targetW: number;
  targetH: number;
  /** 画布槽位内内容偏移（42 倍数）。 */
  offsetX: number;
  offsetY: number;
  /** 源域不足时内容级补边像素数（上/下/左/右）。 */
  pad: { top: number; bottom: number; left: number; right: number };
  /** 内容区出现源域补边时为 true。 */
  padOverflow: boolean;
}

export function quant42Floor(v: number): number {
  return Math.floor(v / SUPERPIXEL) * SUPERPIXEL;
}

export function quant42Round(v: number): number {
  return Math.floor(v / SUPERPIXEL + 0.5) * SUPERPIXEL;
}

export function quant42Ceil(v: number): number {
  return Math.ceil(v / SUPERPIXEL) * SUPERPIXEL;
}

export function slotSize(slot: SlotKind): number {
  return slot === 'P' ? 336 : 672;
}

export interface ViewportInput {
  displayWidth: number;
  displayHeight: number;
  roi?: RoiHint | undefined;
  fullFrame: boolean;
  slot: SlotKind;
}

/**
 * 生成视窗计划。调用方保证 displayWidth/Height > 0。
 */
export function planViewport(input: ViewportInput): ViewportPlan {
  const slot = slotSize(input.slot);
  const shortSide = Math.min(input.displayWidth, input.displayHeight);

  if (!input.fullFrame && input.roi) {
    return planSquareViewport(input, slot, shortSide);
  }
  return planInscribeViewport(input, slot);
}

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}

/** 规格化 roi 到显示像素矩形并钳制到 [0,1]。 */
export function roiToPixels(
  roi: RoiHint,
  displayWidth: number,
  displayHeight: number,
): { x: number; y: number; w: number; h: number } {
  const x0 = clamp01(Math.min(roi.x, roi.x + roi.w));
  const y0 = clamp01(Math.min(roi.y, roi.y + roi.h));
  const x1 = clamp01(Math.max(roi.x, roi.x + roi.w));
  const y1 = clamp01(Math.max(roi.y, roi.y + roi.h));
  return {
    x: Math.round(x0 * displayWidth),
    y: Math.round(y0 * displayHeight),
    w: Math.max(1, Math.round((x1 - x0) * displayWidth)),
    h: Math.max(1, Math.round((y1 - y0) * displayHeight)),
  };
}

function planSquareViewport(input: ViewportInput, slot: number, shortSide: number): ViewportPlan {
  const roi = roiToPixels(input.roi!, input.displayWidth, input.displayHeight);
  const envelope = Math.max(roi.w, roi.h);
  // 边长：源短边向下取整（不越源界）与包络目标区向上取整（不裁目标）取小；
  // 硬下限 84（源域外扩优先）。
  let side = Math.min(quant42Floor(shortSide), quant42Ceil(envelope));
  let padOverflow = false;
  let pad = { top: 0, bottom: 0, left: 0, right: 0 };
  if (side < MIN_SHORT_SIDE) {
    side = MIN_SHORT_SIDE;
    if (side > quant42Floor(shortSide)) {
      // 源短边物理上不足 84：内容级补边（源域外扩到物理边界仍不足）
      padOverflow = true;
    }
  }
  // 视窗中心 = RoI 中心，钳制到源内；起始坐标对齐 42 网格
  const cx = roi.x + roi.w / 2;
  const cy = roi.y + roi.h / 2;
  let x = quant42Floor(Math.round(cx - side / 2));
  let y = quant42Floor(Math.round(cy - side / 2));
  x = Math.min(Math.max(x, 0), Math.max(0, input.displayWidth - side));
  y = Math.min(Math.max(y, 0), Math.max(0, input.displayHeight - side));
  x = quant42Floor(x);
  y = quant42Floor(y);
  // 越界侧记录内容级补边（源域不足的方向）
  const overRight = x + side - input.displayWidth;
  const overBottom = y + side - input.displayHeight;
  if (overRight > 0) {
    pad = { ...pad, right: overRight };
    padOverflow = true;
  }
  if (overBottom > 0) {
    pad = { ...pad, bottom: overBottom };
    padOverflow = true;
  }
  return {
    sourceCropBbox: [x, y, side, side],
    targetW: slot,
    targetH: slot,
    offsetX: 0,
    offsetY: 0,
    pad,
    padOverflow,
  };
}

function planInscribeViewport(input: ViewportInput, slot: number): ViewportPlan {
  const { displayWidth: w, displayHeight: h } = input;
  const budget = slot * slot;
  const k = Math.min(slot / w, slot / h, Math.sqrt(budget / (w * h)));
  let targetW = Math.min(quant42Round(w * k), slot);
  let targetH = Math.min(quant42Round(h * k), slot);
  // 短边硬约束（软面积预算让位）
  if (targetW < MIN_SHORT_SIDE) targetW = Math.min(MIN_SHORT_SIDE, quant42Floor(slot));
  if (targetH < MIN_SHORT_SIDE) targetH = Math.min(MIN_SHORT_SIDE, quant42Floor(slot));
  // 内接居中，偏置对齐 42 网格
  const offsetX = quant42Floor((slot - targetW) / 2);
  const offsetY = quant42Floor((slot - targetH) / 2);
  return {
    sourceCropBbox: [0, 0, w, h],
    targetW,
    targetH,
    offsetX,
    offsetY,
    pad: {
      top: offsetY,
      bottom: slot - targetH - offsetY,
      left: offsetX,
      right: slot - targetW - offsetX,
    },
    padOverflow: false,
  };
}

/**
 * 按视窗计划把源帧变换为槽位内容图（槽位尺寸，含内容级补边与居中灰）。
 */
export function applyViewport(src: RgbImage, plan: ViewportPlan, slot: SlotKind): RgbImage {
  const slotSide = slotSize(slot);
  const [cx, cy, cw, ch] = plan.sourceCropBbox;
  const cropped = cropWithGrayFallback(src, cx, cy, cw, ch);
  const scaled = bilinearResize(cropped, plan.targetW, plan.targetH);
  if (plan.targetW === slotSide && plan.targetH === slotSide) return scaled;
  // 非满槽（全画幅内接）：居中放置，四周中性灰
  const canvas = { width: slotSide, height: slotSide, data: Buffer.alloc(slotSide * slotSide * 3, PAD_GRAY) };
  for (let dy = 0; dy < plan.targetH; dy++) {
    for (let dx = 0; dx < plan.targetW; dx++) {
      const si = (dy * plan.targetW + dx) * 3;
      const di = ((plan.offsetY + dy) * slotSide + plan.offsetX + dx) * 3;
      const r = scaled.data[si]!;
      const g = scaled.data[si + 1]!;
      const b = scaled.data[si + 2]!;
      canvas.data[di] = r;
      canvas.data[di + 1] = g;
      canvas.data[di + 2] = b;
    }
  }
  return canvas;
}
