/**
 * 纯 TS 图像操作（ADR-003/ADR-006：不依赖原生图像库，保证同像素同字节）。
 *
 * 全部函数为确定性纯函数：定点/整数算术，无浮点漂移、无随机源。
 */

import { PNG } from 'pngjs';

/** 中性灰 RGB(128,128,128)。 */
export const PAD_GRAY = 128;

/** 画布与单元的像素格式：rgb24 紧密排列。 */
export interface RgbImage {
  width: number;
  height: number;
  data: Buffer; // length = width*height*3
}

export function makeImage(width: number, height: number, fill = PAD_GRAY): RgbImage {
  const data = Buffer.alloc(width * height * 3, fill);
  return { width, height, data };
}

/** 从源图裁剪矩形区域（越界部分填中性灰——源域外扩不足时的内容级补边路径）。 */
export function cropWithGrayFallback(
  src: RgbImage,
  x: number,
  y: number,
  w: number,
  h: number,
): RgbImage {
  const out = makeImage(w, h, PAD_GRAY);
  for (let dy = 0; dy < h; dy++) {
    const sy = y + dy;
    if (sy < 0 || sy >= src.height) continue;
    for (let dx = 0; dx < w; dx++) {
      const sx = x + dx;
      if (sx < 0 || sx >= src.width) continue;
      const si = (sy * src.width + sx) * 3;
      const di = (dy * w + dx) * 3;
      const r = src.data[si]!;
      const g = src.data[si + 1]!;
      const b = src.data[si + 2]!;
      out.data[di] = r;
      out.data[di + 1] = g;
      out.data[di + 2] = b;
    }
  }
  return out;
}

/**
 * 双线性缩放（16.16 定点采样，确定性）。
 * 采样映射：dst(u,v) = src((u+0.5)*sw/dw-0.5, (v+0.5)*sh/dh-0.5)，越界钳制到边缘。
 */
export function bilinearResize(src: RgbImage, dw: number, dh: number): RgbImage {
  if (src.width === dw && src.height === dh) return src;
  const out = makeImage(dw, dh);
  const FX = 1 << 16;
  const stepX = Math.floor((src.width * FX) / dw);
  const stepY = Math.floor((src.height * FX) / dh);
  const maxSX = (src.width - 1) * FX;
  const maxSY = (src.height - 1) * FX;
  for (let v = 0; v < dh; v++) {
    const fy = (2 * v + 1) * stepY >> 1; // (v+0.5)*stepY，定点
    const cy = Math.min(Math.max(fy - (FX >> 1), 0), maxSY);
    const y0 = cy >> 16;
    const y1 = Math.min(y0 + 1, src.height - 1);
    const wy = (cy - (y0 << 16)) >> 8; // 0..256
    for (let u = 0; u < dw; u++) {
      const fx = (2 * u + 1) * stepX >> 1;
      const cx = Math.min(Math.max(fx - (FX >> 1), 0), maxSX);
      const x0 = cx >> 16;
      const x1 = Math.min(x0 + 1, src.width - 1);
      const wx = (cx - (x0 << 16)) >> 8; // 0..256
      const i00 = (y0 * src.width + x0) * 3;
      const i10 = (y0 * src.width + x1) * 3;
      const i01 = (y1 * src.width + x0) * 3;
      const i11 = (y1 * src.width + x1) * 3;
      const di = (v * dw + u) * 3;
      for (let c = 0; c < 3; c++) {
        const v00 = src.data[i00 + c]!;
        const v10 = src.data[i10 + c]!;
        const v01 = src.data[i01 + c]!;
        const v11 = src.data[i11 + c]!;
        const top = (v00 * (256 - wx) + v10 * wx) >> 8;
        const bot = (v01 * (256 - wx) + v11 * wx) >> 8;
        out.data[di + c] = (top * (256 - wy) + bot * wy) >> 8;
      }
    }
  }
  return out;
}

export interface Placement {
  x: number;
  y: number;
  image: RgbImage;
}

/** 画布拼合：指定放置区贴图，其余区域保持中性灰。 */
export function composeCanvas(width: number, height: number, placements: Placement[]): RgbImage {
  const canvas = makeImage(width, height, PAD_GRAY);
  for (const p of placements) {
    const { image } = p;
    for (let dy = 0; dy < image.height; dy++) {
      const sy = p.y + dy;
      if (sy < 0 || sy >= height) continue;
      for (let dx = 0; dx < image.width; dx++) {
        const sx = p.x + dx;
        if (sx < 0 || sx >= width) continue;
        const si = (dy * image.width + dx) * 3;
        const di = (sy * width + sx) * 3;
        const r = image.data[si]!;
        const g = image.data[si + 1]!;
        const b = image.data[si + 2]!;
        canvas.data[di] = r;
        canvas.data[di + 1] = g;
        canvas.data[di + 2] = b;
      }
    }
  }
  return canvas;
}

/** PNG 编码（字节幂等：固定 colorType/deflateLevel/deflateStrategy，无时间块）。 */
export function encodePng(image: RgbImage): Buffer {
  const rgba = Buffer.alloc(image.width * image.height * 4);
  for (let i = 0, j = 0; i < image.width * image.height; i++, j += 4) {
    rgba[j] = image.data[i * 3]!;
    rgba[j + 1] = image.data[i * 3 + 1]!;
    rgba[j + 2] = image.data[i * 3 + 2]!;
    rgba[j + 3] = 255;
  }
  const png = new PNG({ width: image.width, height: image.height });
  png.data = rgba;
  // pngjs 写入侧按 RGBA 输入读取、按 colorType 2 输出丢弃 alpha；
  // inputHasAlpha:false 会让 pngjs 把输入当 RGB 三元组逐字节读取（错位），不得使用。
  return PNG.sync.write(png, {
    colorType: 2,
    deflateLevel: 6,
    deflateStrategy: 0,
  });
}

/** PNG 解码（测试与基准比对用）。 */
export function decodePng(bytes: Buffer): RgbImage {
  const png = PNG.sync.read(bytes);
  const out = makeImage(png.width, png.height);
  for (let i = 0; i < png.width * png.height; i++) {
    out.data[i * 3] = png.data[i * 4]!;
    out.data[i * 3 + 1] = png.data[i * 4 + 1]!;
    out.data[i * 3 + 2] = png.data[i * 4 + 2]!;
  }
  return out;
}
