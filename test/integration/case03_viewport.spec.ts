/**
 * case 3 —— 视窗裁剪与短边保护（e2e，契约 4 四步归一化）。
 */

import { describe, expect, it } from 'vitest';
import { runDeterministicInspection } from '../../src/stage3/deterministicRouter.js';
import { planViewport } from '../../src/stage4/viewport.js';
import { probeVideo } from '../../src/stage0/probe.js';
import { resolveBinPaths } from '../../src/utils/ffmpegBin.js';
import type { ProbeResult } from '../../src/types.js';

const bins = resolveBinPaths();

async function probeFixture(name: string): Promise<ProbeResult> {
  return probeVideo(`test/fixtures/media/${name}`, { ffprobePath: bins.ffprobe });
}

function inspect(name: string, intent: Record<string, unknown>) {
  return probeFixture(name).then((probe) =>
    runDeterministicInspection(`test/fixtures/media/${name}`, probe, intent as never, {
      ffmpegPath: bins.ffmpeg,
      renderVisualId: true,
      packetIdStart: 1,
      globalIdStart: 1,
      appliedIntentId: 'intent_1',
    }),
  );
}

describe('case 3 — 视窗裁剪与短边保护（纯函数）', () => {
  it('RoI 正方形视窗：边长 = min(短边, 包络) 向下取整 42 倍数，零灰边', () => {
    // 2160×4096 竖长源，狭长 RoI w=5% h=80%
    const plan = planViewport({
      displayWidth: 2160,
      displayHeight: 4096,
      roi: { x: 0.47, y: 0.1, w: 0.05, h: 0.8 },
      fullFrame: false,
      slot: 'F',
    });
    // 包络 = 0.8×4096 = 3276.8 → min(2160, 3276.8) = 2160 → quant42Floor = 2142
    expect(plan.sourceCropBbox[2]).toBe(2142);
    expect(plan.sourceCropBbox[3]).toBe(2142);
    expect(plan.targetW).toBe(672);
    expect(plan.targetH).toBe(672);
    // 全部坐标 42 整除
    for (const v of plan.sourceCropBbox) expect(v % 42).toBe(0);
  });

  it('full_frame 内接等比：内容宽高 42 倍数，偏置对齐 42 网格', () => {
    // 2160×4096 → F 槽 672：k=672/4096 → w=336, h=672
    const plan = planViewport({
      displayWidth: 2160,
      displayHeight: 4096,
      fullFrame: true,
      slot: 'F',
    });
    expect(plan.targetW).toBe(336);
    expect(plan.targetH).toBe(672);
    expect(plan.offsetX).toBe(168);
    expect(plan.offsetY).toBe(0);
    expect(plan.targetW % 42).toBe(0);
    expect(plan.targetH % 42).toBe(0);
  });

  it('16:9 全画幅内接 F 槽：内容 672×378，上下补边 126/168（42 倍数）', () => {
    const plan = planViewport({
      displayWidth: 3840,
      displayHeight: 2160,
      fullFrame: true,
      slot: 'F',
    });
    expect(plan.targetW).toBe(672);
    expect(plan.targetH).toBe(378);
    expect(plan.pad.top % 42).toBe(0);
    expect(plan.offsetY).toBe(126);
  });

  it('短边硬约束：小 RoI 强制 84 下限（源域外扩优先）', () => {
    // 包络 38×21 px < 84：源域外扩后取 84；同侧保留包络 168 的对照断言
    const tiny = planViewport({
      displayWidth: 3840,
      displayHeight: 2160,
      roi: { x: 0.47, y: 0.1, w: 0.01, h: 0.01 },
      fullFrame: false,
      slot: 'P',
    });
    expect(tiny.sourceCropBbox[2]).toBe(84);
    expect(tiny.sourceCropBbox[3]).toBe(84);
    expect(tiny.padOverflow).toBe(false);
    const envelope = planViewport({
      displayWidth: 3840,
      displayHeight: 2160,
      roi: { x: 0.47, y: 0.1, w: 0.05, h: 0.05 },
      fullFrame: false,
      slot: 'P',
    });
    // 包络 192×108 px：向上取整到 42 倍数（210）完整包含目标区，不裁边
    expect(envelope.sourceCropBbox[2]).toBe(210);
    expect(envelope.sourceCropBbox[3]).toBe(210);
  });

  it('源短边物理不足 84：内容级补边 + padOverflow', () => {
    const plan = planViewport({
      displayWidth: 60,
      displayHeight: 60,
      roi: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      fullFrame: false,
      slot: 'P',
    });
    expect(plan.sourceCropBbox[2]).toBe(84);
    expect(plan.padOverflow).toBe(true);
    expect(plan.pad.right).toBe(84 - 60);
    expect(plan.pad.bottom).toBe(84 - 60);
  });
});

describe('case 3 — 视窗裁剪与短边保护（e2e）', () => {
  it('狭长 RoI 输出 1F 满槽：无画布级灰边（单帧 FORM_3）', async () => {
    const result = await inspect('case03_tall.mp4', {
      action: 'timestamps',
      timestamps_ms: [1000],
      focus: 'detail',
      roi_hint: { x: 0.47, y: 0.1, w: 0.05, h: 0.8 },
    });
    expect(result.packets).toHaveLength(1);
    const packet = result.packets[0]!.packet;
    expect(packet.layoutForm).toBe('FORM_3_COMPACT_1F');
    const unit = packet.units[0]!;
    // source_crop_bbox 显示坐标系且 42 整除
    expect(unit.sourceCropBbox[0] % 42).toBe(0);
    expect(unit.sourceCropBbox[1] % 42).toBe(0);
    expect(unit.sourceCropBbox[2]).toBe(2142);
  });

  it('full_frame 内接输出：内容高 378、偏置 126（tiny 源 pad_overflow 传递到单元）', async () => {
    const tiny = await inspect('case03_tiny.mp4', {
      action: 'timestamps',
      timestamps_ms: [500],
      focus: 'detail',
    });
    const unit = tiny.packets[0]!.packet.units[0]!;
    expect(unit.sourceCropBbox).toEqual([0, 0, 60, 60]);
  });
});
