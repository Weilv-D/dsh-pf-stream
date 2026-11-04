/**
 * Stage 1 —— Sobel 梯度与灰度直方图（64×36 感知灰度图上的纯函数）。
 *
 * 规格《三、前端轻量感知与施密特四状态机》：
 * - g_t 为整帧 3×3 Sobel 梯度幅值均值；
 * - 分块 ḡ_{t,k} 为块内 Sobel 幅值均值（8×9 块）；
 * - 硬切判据用相邻帧 16-bin 归一化灰度直方图 L1 距离。
 *
 * 边界处理：3×3 邻域在图像边缘按最近邻钳制（确定性，无随机性）。
 */

export const GRAY_W = 64;
export const GRAY_H = 36;
export const GRID_COLS = 8;
export const GRID_ROWS = 4;
export const BLOCK_W = 8;
export const BLOCK_H = 9;
export const BLOCK_COUNT = GRID_COLS * GRID_ROWS;

/** 整帧 Sobel 幅值图（长度 GRAY_W*GRAY_H）。 */
export function sobelMagnitude(gray: Float64Array): Float64Array {
  const out = new Float64Array(GRAY_W * GRAY_H);
  for (let y = 0; y < GRAY_H; y++) {
    for (let x = 0; x < GRAY_W; x++) {
      const xm = x > 0 ? x - 1 : 0;
      const xp = x < GRAY_W - 1 ? x + 1 : GRAY_W - 1;
      const ym = y > 0 ? y - 1 : 0;
      const yp = y < GRAY_H - 1 ? y + 1 : GRAY_H - 1;
      const tl = gray[ym * GRAY_W + xm]!;
      const tc = gray[ym * GRAY_W + x]!;
      const tr = gray[ym * GRAY_W + xp]!;
      const ml = gray[y * GRAY_W + xm]!;
      const mr = gray[y * GRAY_W + xp]!;
      const bl = gray[yp * GRAY_W + xm]!;
      const bc = gray[yp * GRAY_W + x]!;
      const br = gray[yp * GRAY_W + xp]!;
      const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
      const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
      out[y * GRAY_W + x] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/** 整帧梯度均值 g_t。 */
export function frameSobelMean(mag: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < mag.length; i++) sum += mag[i]!;
  return sum / mag.length;
}

/** 32 分块的块内 Sobel 幅值均值 ḡ_k。 */
export function blockSobelMeans(mag: Float64Array): Float64Array {
  const out = new Float64Array(BLOCK_COUNT);
  for (let br = 0; br < GRID_ROWS; br++) {
    for (let bc = 0; bc < GRID_COLS; bc++) {
      let sum = 0;
      for (let y = 0; y < BLOCK_H; y++) {
        for (let x = 0; x < BLOCK_W; x++) {
          sum += mag[(br * BLOCK_H + y) * GRAY_W + bc * BLOCK_W + x]!;
        }
      }
      out[br * GRID_COLS + bc] = sum / (BLOCK_W * BLOCK_H);
    }
  }
  return out;
}

/** 16-bin 归一化灰度直方图（总和为 1）。 */
export function grayHistogram16(gray: Float64Array): Float64Array {
  const hist = new Float64Array(16);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i]!;
    const bin = Math.min(15, Math.max(0, Math.floor(v * 16)));
    hist[bin]! += 1;
  }
  const total = gray.length;
  for (let b = 0; b < 16; b++) hist[b] = hist[b]! / total;
  return hist;
}

/** 相邻帧直方图 L1 距离 D_hist。 */
export function histL1Distance(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < 16; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum;
}
