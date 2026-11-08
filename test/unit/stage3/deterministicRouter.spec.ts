/**
 * 确定性路由单元：interval 目标数钳制（P1-1）与批量退化阈值（P2-2）修复回归防线。
 */

import { describe, expect, it } from 'vitest';
import { resolveTargets, shouldBatchDecode } from '../../../src/stage3/deterministicRouter.js';
import type { IntentDirective, ProbeResult } from '../../../src/types.js';

const probe = { lastPtsMs: 60_000 } as unknown as ProbeResult;

describe('resolveTargets · interval 钳制', () => {
  it('目标数超上限时钳制为均匀采样', () => {
    // 60s 窗口 / 100ms = 601 个目标 > 128 上限 → 均匀 128 点
    const intent = { action: 'uniform', interval_ms: 100 } as IntentDirective;
    const targets = resolveTargets(intent, probe, 128);
    expect(targets).toHaveLength(128);
    expect(targets[0]).toBe(0);
    expect(targets[targets.length - 1]).toBe(60_000);
    // 均匀性：相邻目标差落在 floor/ceil(span/(cap-1)) 两档
    const span = 60_000;
    for (let i = 2; i < targets.length; i++) {
      const diff = targets[i]! - targets[i - 1]!;
      expect(diff === Math.floor(span / 127) || diff === Math.ceil(span / 127)).toBe(true);
    }
  });

  it('未超上限时保持原生间隔（行为不变）', () => {
    const intent = { action: 'uniform', interval_ms: 10_000 } as IntentDirective;
    const targets = resolveTargets(intent, probe, 128);
    expect(targets).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000]);
  });

  it('maxTargets=1 时退化为单点 [w0]', () => {
    const intent = { action: 'uniform', interval_ms: 100 } as IntentDirective;
    expect(resolveTargets(intent, probe, 1)).toEqual([0]);
  });

  it('span=0（pts_window [0,0]）返回单点', () => {
    const intent = { action: 'uniform', interval_ms: 1, pts_window: [0, 0] } as IntentDirective;
    const targets = resolveTargets(intent, probe, 128);
    expect(targets).toEqual([0]);
  });
});

describe('shouldBatchDecode 阈值', () => {
  it('块内打满 CHUNK_TARGETS 且平均间隔 ≤2s 才批', () => {
    const dense = Array.from({ length: 20 }, (_, i) => i * 500);
    expect(shouldBatchDecode(dense)).toBe(true);
    expect(shouldBatchDecode(dense.slice(0, 19))).toBe(false);
    const sparse = Array.from({ length: 20 }, (_, i) => i * 5_000);
    expect(shouldBatchDecode(sparse)).toBe(false);
  });

  it('密集大块（>20）同样批（块内 used 可达 24）', () => {
    const chunk = Array.from({ length: 24 }, (_, i) => i * 500);
    expect(shouldBatchDecode(chunk)).toBe(true);
  });
});
