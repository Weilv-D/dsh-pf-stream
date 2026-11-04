/**
 * Stage 1 —— 前端轻量感知：双通道变化标量 d_t 与频闪翻转率 r_flip。
 *
 * 规格《三》§1/§2：
 * - 64×36 归一化灰度 → 32 分块（8 列 × 4 行，每块 8×9）；
 * - δ_k = clamp(δ_raw/(ḡ_k+0.05) × 0.25, 0, 1)，ΔB_k = w_k·δ_k（roi_hint 命中 w=2.0，其余 0.5）；
 * - d_global = ΣΔB/Σw；d_local = 前 3 极值块均值（空间 8-邻域连通 + 时间持续门控）；
 * - d_t = max(d_global, d_local)；
 * - r_flip：|M_t| ≥ 16 时连续两步差分符号翻转比例，> 0.6 → α=0.1，否则 α=1.0；
 * - 等效 30fps 步长（ΔPTS ≥ 33.3ms）由流式引擎在送帧前保证，变帧率时间归一
 *   （× ΔPTS/33.3）在积分侧执行（Stage 3）。
 */

import type { BlockSignal, RoiHint } from '../types.js';
import {
  BLOCK_COUNT,
  BLOCK_H,
  BLOCK_W,
  GRAY_H,
  GRAY_W,
  GRID_COLS,
  blockSobelMeans,
  grayHistogram16,
  histL1Distance,
  sobelMagnitude,
} from './gradient.js';

const GAMMA_SCALE = 0.25;
const GRAD_EPS = 0.05;
const FLIP_PIXEL_THRESHOLD = 0.02;
const FLIP_MIN_PIXELS = 16;
const TOP_K = 3;

/** 分块网格坐标。 */
export function blockGridPos(k: number): { row: number; col: number } {
  return { row: Math.floor(k / GRID_COLS), col: k % GRID_COLS };
}

/** 切比雪夫距离 D∞。 */
export function chebyshev(a: number, b: number): number {
  const pa = blockGridPos(a);
  const pb = blockGridPos(b);
  return Math.max(Math.abs(pa.row - pb.row), Math.abs(pa.col - pb.col));
}

/** roi_hint → 32 分块权重（命中块 2.0，其余 0.5；无 roi 全 1.0）。 */
export function blockWeights(roi: RoiHint | null | undefined): number[] {
  const w = new Array<number>(BLOCK_COUNT).fill(1);
  if (!roi) return w;
  for (let br = 0; br < 4; br++) {
    for (let bc = 0; bc < GRID_COLS; bc++) {
      const x0 = bc / GRID_COLS;
      const x1 = (bc + 1) / GRID_COLS;
      const y0 = br / 4;
      const y1 = (br + 1) / 4;
      const overlap =
        Math.max(0, Math.min(x1, roi.x + roi.w) - Math.max(x0, roi.x)) *
        Math.max(0, Math.min(y1, roi.y + roi.h) - Math.max(y0, roi.y));
      w[br * GRID_COLS + bc] = overlap > 0 ? 2.0 : 0.5;
    }
  }
  return w;
}

export interface PerceptionContext {
  /** 上一感知步灰度图（首帧为 null）。 */
  prevGray: Float64Array | null;
  /** 上一感知步有符号帧差 ΔI_{t-1}。 */
  prevDelta: Float64Array | null;
  /** 上一感知步前 3 极值块索引 K_{t-1}（d_local=0 或首帧后为 null）。 */
  prevTopK: number[] | null;
  /** 上一感知步极值块索引 k*_{t-1}。 */
  prevArgmax: number | null;
  /** 上一感知步位移向量 v_{t-1}（k* 网格位移）。 */
  prevVec: [number, number] | null;
  /** 上一感知步 16-bin 直方图。 */
  prevHist: Float64Array | null;
}

export function createPerceptionContext(): PerceptionContext {
  return { prevGray: null, prevDelta: null, prevTopK: null, prevArgmax: null, prevHist: null, prevVec: null };
}

/** 重置时间持续上下文（SWITCH 原子步骤 4 后调用）。 */
export function resetTemporalContext(ctx: PerceptionContext): void {
  ctx.prevTopK = null;
  ctx.prevArgmax = null;
  ctx.prevVec = null;
}

export interface PerceptionResult {
  ptsMs: number;
  blocks: BlockSignal[];
  dGlobal: number;
  dLocal: number;
  d: number;
  /** 整帧 Sobel 均值 g_t。 */
  g: number;
  rFlip: number;
  alpha: number;
  /** 硬切候选：δ_raw>0.30 或 δ>0.30 的分块数。 */
  switchCandidateBlocks: number;
  /** 与上一帧的直方图 L1 距离（上一帧缺失时为 0）。 */
  histL1: number;
  /** 本步前 3 极值块（未通过门控也为调用方保留上下文）。 */
  topK: number[];
  argmax: number;
  vec: [number, number] | null;
  hist: Float64Array;
}

/**
 * 单感知步。调用方保证步进 ΔPTS ≥ 33.3ms。
 * hHighEff 用于高速跨块补偿门控（位移 2 块时 δ_{k*} > 2×H_high_eff）。
 */
export function perceiveFrame(
  ctx: PerceptionContext,
  ptsMs: number,
  gray: Float64Array,
  weights: number[],
  hHighEff: number,
): PerceptionResult {
  const mag = sobelMagnitude(gray);
  const blockSobel = blockSobelMeans(mag);
  let g = 0;
  for (let i = 0; i < mag.length; i++) g += mag[i]!;
  g /= mag.length;

  const hist = grayHistogram16(gray);
  const histL1 = ctx.prevHist ? histL1Distance(hist, ctx.prevHist) : 0;

  const blocks: BlockSignal[] = [];
  const delta = new Float64Array(gray.length);
  let flipCount = 0;
  let mCount = 0;

  if (ctx.prevGray) {
    for (let i = 0; i < gray.length; i++) {
      delta[i] = gray[i]! - ctx.prevGray[i]!;
    }
    for (let y = 0; y < GRAY_H; y++) {
      for (let x = 0; x < GRAY_W; x++) {
        const i = y * GRAY_W + x;
        const dt = delta[i]!;
        if (Math.abs(dt) > FLIP_PIXEL_THRESHOLD) {
          mCount++;
          const dprev = ctx.prevDelta ? ctx.prevDelta[i]! : 0;
          if (Math.abs(dprev) > FLIP_PIXEL_THRESHOLD && dt * dprev < 0) flipCount++;
        }
      }
    }
  }

  let switchCandidateBlocks = 0;
  const deltaB = new Float64Array(BLOCK_COUNT);
  for (let br = 0; br < 4; br++) {
    for (let bc = 0; bc < GRID_COLS; bc++) {
      const k = br * GRID_COLS + bc;
      let rawSum = 0;
      for (let y = 0; y < BLOCK_H; y++) {
        for (let x = 0; x < BLOCK_W; x++) {
          rawSum += Math.abs(delta[(br * BLOCK_H + y) * GRAY_W + bc * BLOCK_W + x]!);
        }
      }
      const deltaRaw = rawSum / (BLOCK_W * BLOCK_H);
      const deltaNorm = Math.min(1, Math.max(0, (deltaRaw / (blockSobel[k]! + GRAD_EPS)) * GAMMA_SCALE));
      deltaB[k] = weights[k]! * deltaNorm;
      blocks.push({
        row: br,
        col: bc,
        deltaRaw,
        delta: deltaNorm,
        weight: weights[k]!,
        sobelMean: blockSobel[k]!,
      });
      if (deltaRaw > 0.3 || deltaNorm > 0.3) switchCandidateBlocks++;
    }
  }

  // 全局通道
  let sumB = 0;
  let sumW = 0;
  for (let k = 0; k < BLOCK_COUNT; k++) {
    sumB += deltaB[k]!;
    sumW += weights[k]!;
  }
  const dGlobal = sumB / sumW;

  // 前 3 极值块（稳定排序：值降序，索引升序）
  const order = Array.from({ length: BLOCK_COUNT }, (_, k) => k).sort((a, b) => {
    const diff = deltaB[b]! - deltaB[a]!;
    return diff !== 0 ? diff : a - b;
  });
  const topK = order.slice(0, TOP_K);
  const argmax = topK[0]!;

  // 空间连通：K_t 中至少 2 块互为 8-邻域
  let spatial = false;
  for (let i = 0; i < topK.length && !spatial; i++) {
    for (let j = i + 1; j < topK.length; j++) {
      if (chebyshev(topK[i]!, topK[j]!) <= 1) {
        spatial = true;
        break;
      }
    }
  }

  // 位移向量 v_t
  const pos = blockGridPos(argmax);
  let vec: [number, number] | null = null;
  if (ctx.prevArgmax !== null) {
    const prev = blockGridPos(ctx.prevArgmax);
    vec = [pos.row - prev.row, pos.col - prev.col];
  }

  // 时间持续与高速跨块补偿
  let temporal = false;
  if (ctx.prevTopK === null || ctx.prevTopK.length === 0) {
    temporal = true; // 首帧 / 状态重置帧：仅由空间连通决定
  } else {
    let minDist = Infinity;
    for (const j of ctx.prevTopK) minDist = Math.min(minDist, chebyshev(argmax, j));
    if (minDist <= 1) {
      temporal = true;
    } else if (minDist === 2) {
      const strongEnough = blocks[argmax]!.delta > 2 * hHighEff;
      const aligned =
        vec !== null && ctx.prevVec !== null && cosineSimilarity(vec, ctx.prevVec) >= 0.5;
      temporal = strongEnough && aligned;
    }
  }

  let dLocal = 0;
  if (spatial && temporal) {
    let s = 0;
    for (const k of topK) s += deltaB[k]!;
    dLocal = s / TOP_K;
  }

  const rFlip = mCount < FLIP_MIN_PIXELS ? 0 : flipCount / mCount;
  const alpha = rFlip > 0.6 ? 0.1 : 1.0;

  // 上下文更新
  ctx.prevGray = gray;
  ctx.prevDelta = delta;
  ctx.prevTopK = dLocal > 0 ? topK : null;
  ctx.prevArgmax = argmax;
  ctx.prevVec = vec;
  ctx.prevHist = hist;

  return {
    ptsMs,
    blocks,
    dGlobal,
    dLocal,
    d: Math.max(dGlobal, dLocal),
    g,
    rFlip,
    alpha,
    switchCandidateBlocks,
    histL1,
    topK,
    argmax,
    vec,
    hist,
  };
}

function cosineSimilarity(a: [number, number], b: [number, number]): number {
  const dot = a[0] * b[0] + a[1] * b[1];
  const na = Math.hypot(a[0], a[1]);
  const nb = Math.hypot(b[0], b[1]);
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}

/** RGB 图 → 64×36 归一化灰度（box 均值降采样）。 */
export function toGray64x36(width: number, height: number, rgb: Uint8Array): Float64Array {
  const out = new Float64Array(GRAY_W * GRAY_H);
  for (let gy = 0; gy < GRAY_H; gy++) {
    const y0 = Math.floor((gy * height) / GRAY_H);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / GRAY_H));
    for (let gx = 0; gx < GRAY_W; gx++) {
      const x0 = Math.floor((gx * width) / GRAY_W);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / GRAY_W));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 3;
          const r = rgb[i]!;
          const gg = rgb[i + 1]!;
          const b = rgb[i + 2]!;
          sum += 0.299 * r + 0.587 * gg + 0.114 * b;
          count++;
        }
      }
      out[gy * GRAY_W + gx] = count > 0 ? sum / count / 255 : 0;
    }
  }
  return out;
}
