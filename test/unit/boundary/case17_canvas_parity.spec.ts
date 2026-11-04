/**
 * 用例 17（boundary，纯逻辑）：确定性 timestamps / uniform 与 pf_stream 流式
 * 三通道共享 Stage 4 打包函数——同一帧与视窗参数产生同一 CanvasPacket 结构。
 */

import { describe, expect, it } from 'vitest';
import { packCanvas } from '../../../src/stage4/canvasPacker.js';
import { planGroups, resolveTargets, shouldBatchDecode } from '../../../src/stage3/deterministicRouter.js';
import type { ProbeResult } from '../../../src/types.js';
import type { UnitInput } from '../../../src/stage4/canvasPacker.js';
import type { RgbImage } from '../../../src/utils/image.js';

function solid(w: number, h: number, v: number): RgbImage {
  const data = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const o = i * 3;
    data[o] = v;
    data[o + 1] = v + 1;
    data[o + 2] = v + 2;
  }
  return { width: w, height: h, data };
}

const PROBE: ProbeResult = {
  codedWidth: 640,
  codedHeight: 360,
  displayWidth: 640,
  displayHeight: 360,
  rotation: 0,
  durationMs: 4000,
  lastPtsMs: 3966.67,
  avgFps: 30,
  codec: 'h264',
  audioStreams: [],
  subtitleStreams: [],
};

const BASE = {
  appliedIntentId: 'intent_1',
  renderVisualId: false,
  triggerPath: 'DETERMINISTIC' as const,
};

function stripVolatile(packet: { packetId: number; triggerPath: string; units: unknown[] }) {
  // packetId/globalId/triggerPath 为通道与序号元数据，结构比对时剔除
  const { triggerPath: _tp, ...rest } = packet;
  return JSON.stringify({ ...rest, packetId: 0, units: packet.units.map((u) => ({ ...(u as object), globalId: 0 })) });
}

describe('三通道共享 Stage 4 打包契约（用例 17）', () => {
  const p336 = (n: number) => solid(336, 336, 40 + n * 3);
  const f672 = solid(672, 672, 200);

  it('同一组单元输入 → 同一形态下 strip 字节与描述结构逐字段一致（流式 SETTLE 与确定性通道）', () => {
    const units = (): UnitInput[] => [
      { globalId: 1, ptsMs: 1000, scale: '1x1_P', eventType: 'MOTION', image: p336(0), sourceCropBbox: [0, 0, 336, 336] },
      { globalId: 2, ptsMs: 1100, scale: '1x1_P', eventType: 'MOTION', image: p336(1), sourceCropBbox: [336, 0, 672, 336] },
      { globalId: 3, ptsMs: 1200, scale: '1x1_P', eventType: 'MOTION', image: p336(2), sourceCropBbox: [0, 336, 336, 672] },
      { globalId: 4, ptsMs: 1300, scale: '1x1_P', eventType: 'MOTION', image: p336(3), sourceCropBbox: [336, 336, 672, 672] },
      { globalId: 5, ptsMs: 1400, scale: '2x2_F', eventType: 'SETTLE', image: f672, sourceCropBbox: [0, 0, 672, 672] },
    ];
    // 通道 A：流式 SETTLE 路径的打包入参
    const a = packCanvas('FORM_1_STANDARD_STRIP', units(), { ...BASE, packetId: 1, triggerPath: 'SETTLE' });
    // 通道 B：确定性 balanced 满组路径的打包入参（同帧同视窗）
    const b = packCanvas('FORM_1_STANDARD_STRIP', units(), { ...BASE, packetId: 99, triggerPath: 'DETERMINISTIC' });
    expect(a.imageBytes.equals(b.imageBytes)).toBe(true);
    expect(a.packet.stripSha256).toBe(b.packet.stripSha256);
    expect(a.packet.units.map((u) => [u.contentPixelBbox, u.tokenGridBbox, u.scale, u.timestampMs]))
      .toEqual(b.packet.units.map((u) => [u.contentPixelBbox, u.tokenGridBbox, u.scale, u.timestampMs]));
    expect(stripVolatile(a.packet)).toBe(stripVolatile(b.packet));
  });

  it('FORM_3 单帧：流式 SWITCH_STATIC 与确定性单时间戳检视同构', () => {
    const fUnit = (): UnitInput[] => [
      { globalId: 7, ptsMs: 2600, scale: '2x2_F', eventType: 'SWITCH_STATIC', image: f672, sourceCropBbox: [0, 0, 672, 672] },
    ];
    const a = packCanvas('FORM_3_COMPACT_1F', fUnit(), { ...BASE, packetId: 1, triggerPath: 'SWITCH_STATIC' });
    const b = packCanvas('FORM_3_COMPACT_1F', fUnit(), { ...BASE, packetId: 2, triggerPath: 'DETERMINISTIC' });
    expect(a.imageBytes.equals(b.imageBytes)).toBe(true);
    expect(a.packet.canvasSize).toEqual([672, 672]);
    expect(a.packet.stripSha256).toBeNull();
  });

  it('planGroups 分档与 resolveTargets/批量退化判定', () => {
    const ts = [0, 100, 200, 300, 400, 500];
    expect(planGroups(ts, 'balanced', false).map((g) => g.form)).toEqual(['FORM_1_STANDARD_STRIP', 'FORM_3_COMPACT_1F']);
    expect(planGroups([0, 100], 'balanced', false)[0]!.form).toBe('FORM_4_PARTIAL_STRIP');
    expect(planGroups([0], 'balanced', false)[0]!.form).toBe('FORM_3_COMPACT_1F');
    // focus=motion 只组满 4 帧的 FORM_2（末组余量 2 帧不组包，避免非法 4P 断言）
    expect(planGroups(ts, 'motion', false).map((g) => g.form)).toEqual(['FORM_2_COMPACT_4P']);
    expect(planGroups(ts, 'motion', false)[0]!.pCount).toBe(4);
    expect(planGroups(ts, 'detail', false).every((g) => g.form === 'FORM_3_COMPACT_1F')).toBe(true);
    expect(planGroups(ts, 'balanced', true).every((g) => g.form === 'FORM_3_COMPACT_1F')).toBe(true);

    const targets = resolveTargets({ action: 'timestamps', timestamps_ms: [500, 100, 500, 99999] }, PROBE);
    expect(targets).toEqual([100, 500, 3966.67]);
    const uniform = resolveTargets({ action: 'uniform', frame_count: 5 }, PROBE);
    // 均分目标取整毫秒，末点保持钳制值（不二次取整）
    expect(uniform).toEqual([0, 992, 1983, 2975, 3966.67]);
    expect(shouldBatchDecode(uniform)).toBe(false);
    const dense = resolveTargets({ action: 'uniform', interval_ms: 100 }, PROBE);
    expect(dense.length).toBeGreaterThanOrEqual(32);
    expect(shouldBatchDecode(dense)).toBe(true);
  });
});
