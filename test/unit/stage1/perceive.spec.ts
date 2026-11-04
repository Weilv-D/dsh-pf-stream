/**
 * Stage 1 感知层单元测试（用例 6 的标定部分）：
 * 梯度归一化（暗光/高对比度同运动同 d）、双通道合成、r_flip/α、
 * 直方图 L1、空间权重、首帧与重置帧行为。
 */

import { describe, expect, it } from 'vitest';
import {
  blockGridPos,
  blockWeights,
  chebyshev,
  createPerceptionContext,
  perceiveFrame,
  resetTemporalContext,
} from '../../../src/stage1/perceive.js';
import { GRAY_W, GRAY_H } from '../../../src/stage1/gradient.js';

const W = GRAY_W;
const H = GRAY_H;

function frameWithBox(boxX: number, bg = 0.5, box = 1.0, scale = 1): Float64Array {
  const g = new Float64Array(W * H).fill(bg * scale);
  for (let y = 4; y < 12; y++) {
    for (let x = boxX; x < boxX + 8; x++) {
      if (x >= 0 && x < W) g[y * W + x] = box * scale;
    }
  }
  return g;
}

const UNITY = new Array<number>(32).fill(1);

describe('blockWeights / 网格几何', () => {
  it('无 roi 时全 1.0', () => {
    expect(blockWeights(null).every((w) => w === 1)).toBe(true);
  });
  it('roi 命中块 2.0，其余 0.5', () => {
    const w = blockWeights({ x: 0, y: 0, w: 0.125, h: 0.25 });
    expect(w[0]).toBe(2);
    expect(w.filter((x) => x === 0.5).length).toBe(31);
  });
  it('切比雪夫距离与网格坐标', () => {
    expect(blockGridPos(9)).toEqual({ row: 1, col: 1 });
    expect(chebyshev(0, 9)).toBe(1);
    expect(chebyshev(0, 2)).toBe(2);
  });
});

describe('perceiveFrame 首帧与运动检测', () => {
  it('首帧 d=0、histL1=0、alpha=1', () => {
    const ctx = createPerceptionContext();
    const r = perceiveFrame(ctx, 0, frameWithBox(10), UNITY, 0.1);
    expect(r.d).toBe(0);
    expect(r.histL1).toBe(0);
    expect(r.alpha).toBe(1);
    expect(r.rFlip).toBe(0);
    expect(ctx.prevGray).not.toBeNull();
  });

  it('局部运动：d>0 且极值块落在运动区域', () => {
    const ctx = createPerceptionContext();
    perceiveFrame(ctx, 0, frameWithBox(10), UNITY, 0.1);
    const r = perceiveFrame(ctx, 100, frameWithBox(14), UNITY, 0.1);
    expect(r.d).toBeGreaterThan(0);
    expect(r.topK.length).toBe(3);
    const cols = new Set(r.topK.map((k) => blockGridPos(k).col));
    expect(cols.size).toBeLessThanOrEqual(2); // 局部连通
  });

  it('静止帧对：d≈0', () => {
    const ctx = createPerceptionContext();
    perceiveFrame(ctx, 0, frameWithBox(10), UNITY, 0.1);
    const r = perceiveFrame(ctx, 100, frameWithBox(10), UNITY, 0.1);
    expect(r.d).toBeLessThan(0.01);
  });
});

describe('梯度归一化标定（暗光 vs 正常，同位移）', () => {
  it('低对比度版 d 达到正常版的 60% 以上（量纲剥离）', () => {
    const ctxA = createPerceptionContext();
    const ctxB = createPerceptionContext();
    perceiveFrame(ctxA, 0, frameWithBox(10), UNITY, 0.1);
    const bright = perceiveFrame(ctxA, 100, frameWithBox(14), UNITY, 0.1);
    perceiveFrame(ctxB, 0, frameWithBox(10, 0.5, 1.0, 0.25), UNITY, 0.1);
    const dark = perceiveFrame(ctxB, 100, frameWithBox(14, 0.5, 1.0, 0.25), UNITY, 0.1);
    expect(dark.d).toBeGreaterThan(0);
    expect(dark.d).toBeGreaterThanOrEqual(bright.d * 0.6);
  });
});

describe('r_flip 与 α', () => {
  it('大面积符号翻转 → r_flip 高、α=0.1', () => {
    const ctx = createPerceptionContext();
    const base = new Float64Array(W * H).fill(0.5);
    const up = new Float64Array(W * H).fill(0.7);
    const down = new Float64Array(W * H).fill(0.3);
    perceiveFrame(ctx, 0, base, UNITY, 0.1);
    perceiveFrame(ctx, 100, up, UNITY, 0.1);
    const r = perceiveFrame(ctx, 200, down, UNITY, 0.1);
    expect(r.rFlip).toBeGreaterThan(0.6);
    expect(r.alpha).toBeCloseTo(0.1);
  });

  it('单向运动（持续变亮）→ α=1', () => {
    const ctx = createPerceptionContext();
    const a = new Float64Array(W * H).fill(0.4);
    const b = new Float64Array(W * H).fill(0.5);
    const c = new Float64Array(W * H).fill(0.6);
    perceiveFrame(ctx, 0, a, UNITY, 0.1);
    perceiveFrame(ctx, 100, b, UNITY, 0.1);
    const r = perceiveFrame(ctx, 200, c, UNITY, 0.1);
    expect(r.rFlip).toBeLessThan(0.2);
    expect(r.alpha).toBe(1);
  });

  it('变化像素 <16 → r_flip=0', () => {
    const ctx = createPerceptionContext();
    const a = frameWithBox(10);
    const b = frameWithBox(10);
    b[100] = 0.9; // 单像素变化
    perceiveFrame(ctx, 0, a, UNITY, 0.1);
    const r = perceiveFrame(ctx, 100, b, UNITY, 0.1);
    expect(r.rFlip).toBe(0);
  });
});

describe('直方图 L1 距离与时间重置', () => {
  it('分布突变 histL1 大', () => {
    const ctx = createPerceptionContext();
    perceiveFrame(ctx, 0, new Float64Array(W * H).fill(0.2), UNITY, 0.1);
    const r = perceiveFrame(ctx, 100, new Float64Array(W * H).fill(0.9), UNITY, 0.1);
    expect(r.histL1).toBeGreaterThan(0.5);
  });

  it('resetTemporalContext 后时间持续门直接满足（K_{t-1} 清空）', () => {
    const ctx = createPerceptionContext();
    perceiveFrame(ctx, 0, frameWithBox(10), UNITY, 0.1);
    perceiveFrame(ctx, 100, frameWithBox(14), UNITY, 0.1);
    resetTemporalContext(ctx);
    expect(ctx.prevTopK).toBeNull();
    const r = perceiveFrame(ctx, 200, frameWithBox(18), UNITY, 0.1);
    // 重置后仅由空间连通决定
    expect(r.dLocal).toBeGreaterThan(0);
  });
});
