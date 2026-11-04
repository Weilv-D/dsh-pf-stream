/**
 * 消费端视觉标记（《六、发包控制…》§4）：
 * - 双色高对比内缩隔离线：单元边缘向内侧 2px（外层 1px 深色 RGB(32,32,32) + 内层 1px 亮色 RGB(224,224,224)）；
 * - 左上角超像素微型反色角标：每单元首个 42×42 超像素内反色胶囊渲染 #global_id（renderVisualId 开关）。
 */

import type { RgbImage } from '../utils/image.js';

const SEPARATOR_DARK = 32;
const SEPARATOR_LIGHT = 224;

export interface UnitBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 在画布上为指定单元区域绘制双色内缩隔离线。 */
export function drawSeparators(canvas: RgbImage, boxes: UnitBbox[]): void {
  const { width: cw, height: ch, data } = canvas;
  for (const b of boxes) {
    // 外层 1px 深色（单元边缘内侧）
    fillRect(data, cw, ch, b.x, b.y, b.w, 1, SEPARATOR_DARK);
    fillRect(data, cw, ch, b.x, b.y + b.h - 1, b.w, 1, SEPARATOR_DARK);
    fillRect(data, cw, ch, b.x, b.y, 1, b.h, SEPARATOR_DARK);
    fillRect(data, cw, ch, b.x + b.w - 1, b.y, 1, b.h, SEPARATOR_DARK);
    // 内层 1px 亮色
    fillRect(data, cw, ch, b.x + 1, b.y + 1, b.w - 2, 1, SEPARATOR_LIGHT);
    fillRect(data, cw, ch, b.x + 1, b.y + b.h - 2, b.w - 2, 1, SEPARATOR_LIGHT);
    fillRect(data, cw, ch, b.x + 1, b.y + 1, 1, b.h - 2, SEPARATOR_LIGHT);
    fillRect(data, cw, ch, b.x + b.w - 2, b.y + 1, 1, b.h - 2, SEPARATOR_LIGHT);
  }
}

function fillRect(
  data: Buffer,
  cw: number,
  ch: number,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number,
): void {
  for (let dy = 0; dy < h; dy++) {
    const py = y + dy;
    if (py < 0 || py >= ch) continue;
    for (let dx = 0; dx < w; dx++) {
      const px = x + dx;
      if (px < 0 || px >= cw) continue;
      const i = (py * cw + px) * 3;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
    }
  }
}

/** 3×5 位图字型（# 与数字）。 */
const GLYPHS: Record<string, string[]> = {
  '#': ['101', '111', '101', '111', '101'],
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
};

/**
 * 反色胶囊角标：在 (originX, originY) 起始的 42×42 超像素内，
 * 对胶囊区域逐像素反色，字型位保持原色（双重反色，高对比）。
 */
export function drawIdBadge(canvas: RgbImage, originX: number, originY: number, globalId: number): void {
  const text = `#${globalId}`;
  const { width: cw, height: ch, data } = canvas;
  const boxX = originX + 4;
  const boxY = originY + 4;
  const boxW = 34;
  const boxH = 34;
  const glyphW = 3;
  const glyphH = 5;
  const totalW = text.length * glyphW + (text.length - 1);
  const startX = boxX + Math.floor((boxW - totalW) / 2);
  const startY = boxY + Math.floor((boxH - glyphH) / 2);
  for (let dy = 0; dy < boxH; dy++) {
    for (let dx = 0; dx < boxW; dx++) {
      const px = boxX + dx;
      const py = boxY + dy;
      if (px < 0 || px >= cw || py < 0 || py >= ch) continue;
      // 角落切角（近似圆角胶囊）
      const corner = Math.min(dx, dy, boxW - 1 - dx, boxH - 1 - dy);
      if (corner < 3 && (dx < 3 || dx > boxW - 4) && (dy < 3 || dy > boxH - 4)) continue;
      const gx = dx - (startX - boxX);
      const gy = dy - (startY - boxY);
      const cell = gx % (glyphW + 1);
      const charIdx = Math.floor(gx / (glyphW + 1));
      const glyph = charIdx >= 0 && charIdx < text.length ? GLYPHS[text[charIdx]!] : undefined;
      const glyphOn =
        glyph !== undefined && gy >= 0 && gy < glyphH && cell < glyphW && glyph[gy]![cell] === '1';
      const i = (py * cw + px) * 3;
      if (glyphOn) continue; // 字型位保持原色
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      data[i] = 255 - r;
      data[i + 1] = 255 - g;
      data[i + 2] = 255 - b;
    }
  }
}
