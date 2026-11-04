/**
 * case 4 —— 42px 模数、530 Tokens 与画布逐位一致性（e2e + 打包器纯逻辑）。
 */

import { describe, expect, it } from 'vitest';
import { runDeterministicInspection } from '../../src/stage3/deterministicRouter.js';
import {
  billTokens,
  canvasSizeOf,
  packCanvas,
  timelineHintLine,
} from '../../src/stage4/canvasPacker.js';
import { probeVideo } from '../../src/stage0/probe.js';
import { resolveBinPaths } from '../../src/utils/ffmpegBin.js';
import { decodePng, makeImage } from '../../src/utils/image.js';
import type { UnitInput } from '../../src/stage4/canvasPacker.js';

const bins = resolveBinPaths();

function gradientUnit(size: number, seed: number): UnitInput['image'] {
  const img = makeImage(size, size, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 3;
      img.data[i] = (x * 3 + seed) % 256;
      img.data[i + 1] = (y * 3 + seed) % 256;
      img.data[i + 2] = ((x + y) * 2 + seed) % 256;
    }
  }
  return img;
}

describe('case 4 — 计费公式与画布几何', () => {
  it('四形态画布尺寸与计费：530/274/274/530', () => {
    expect(canvasSizeOf('FORM_1_STANDARD_STRIP')).toEqual([1344, 672]);
    expect(canvasSizeOf('FORM_2_COMPACT_4P')).toEqual([672, 672]);
    expect(canvasSizeOf('FORM_3_COMPACT_1F')).toEqual([672, 672]);
    expect(canvasSizeOf('FORM_4_PARTIAL_STRIP')).toEqual([1344, 672]);
    expect(billTokens(1344, 672)).toBe(16 * 33 + 2);
    expect(billTokens(672, 672)).toBe(16 * 17 + 2);
  });

  it('FORM_1 单元落位与 token_grid_bbox 精确匹配规格示例值', async () => {
    const probe = await probeVideo('test/fixtures/media/case04_plain.mp4', {
      ffprobePath: bins.ffprobe,
    });
    const result = await runDeterministicInspection(
      'test/fixtures/media/case04_plain.mp4',
      probe,
      { action: 'uniform', interval_ms: 200, max_packets: 1 },
      {
        ffmpegPath: bins.ffmpeg,
        renderVisualId: true,
        packetIdStart: 1,
        globalIdStart: 1,
        appliedIntentId: 'intent_1',
      },
    );
    expect(result.packets).toHaveLength(1);
    const packet = result.packets[0]!.packet;
    expect(packet.layoutForm).toBe('FORM_1_STANDARD_STRIP');
    expect(packet.canvasSize).toEqual([1344, 672]);
    const boxes = packet.units.map((u) => u.contentPixelBbox);
    expect(boxes).toEqual([
      [0, 0, 336, 336],
      [336, 0, 672, 336],
      [0, 336, 336, 672],
      [336, 336, 672, 672],
      [672, 0, 1344, 672],
    ]);
    const grids = packet.units.map((u) => u.tokenGridBbox);
    expect(grids).toEqual([
      [0, 0, 8, 8],
      [0, 8, 8, 16],
      [8, 0, 16, 8],
      [8, 8, 16, 16],
      [0, 16, 16, 32],
    ]);
    // 时序提示行格式（确定性模式带 Mode 段，规格《六、发包控制…》§4 定点单帧检视格式）
    const hint = timelineHintLine(packet, null);
    expect(hint).toMatch(/^\[Packet #1 \| Mode: DETERMINISTIC \| Anchor: #5 \| #1\(P, /);
    expect(hint).toContain('#5(F, ');
    expect(hint).toContain('Right-Half)');
  });
});

describe('case 4 — 打包器逐位一致性与字节幂等', () => {
  it('42px 对齐输入 → 画布单元区域与输入像素逐位相等（关闭视觉标记）', () => {
    const units: UnitInput[] = [
      ...[1, 2, 3, 4].map(
        (seed, i): UnitInput => ({
          globalId: i + 1,
          ptsMs: 1000 + i * 200,
          scale: '1x1_P',
          eventType: 'DETERMINISTIC',
          image: gradientUnit(336, seed * 7),
          sourceCropBbox: [0, 0, 336, 336],
        }),
      ),
      {
        globalId: 5,
        ptsMs: 1800,
        scale: '2x2_F',
        eventType: 'DETERMINISTIC',
        image: gradientUnit(672, 99),
        sourceCropBbox: [0, 0, 672, 672],
      },
    ];
    const artifact = packCanvas('FORM_1_STANDARD_STRIP', units, {
      packetId: 1,
      appliedIntentId: 'intent_1',
      renderVisualId: false,
      triggerPath: 'DETERMINISTIC',
    });
    const canvas = decodePng(artifact.imageBytes);
    expect(canvas.width).toBe(1344);
    expect(canvas.height).toBe(672);
    // 逐位：每个单元内部区域（避开边缘标记带）与输入相等
    const placements: Array<[number, number, UnitInput['image']]> = [
      [0, 0, units[0]!.image],
      [336, 0, units[1]!.image],
      [0, 336, units[2]!.image],
      [336, 336, units[3]!.image],
      [672, 0, units[4]!.image],
    ];
    for (const [px, py, img] of placements) {
      for (let y = 4; y < img.height - 4; y += 37) {
        for (let x = 4; x < img.width - 4; x += 29) {
          const ci = ((py + y) * 1344 + px + x) * 3;
          const si = (y * img.width + x) * 3;
          expect(canvas.data[ci]).toBe(img.data[si]);
          expect(canvas.data[ci + 1]).toBe(img.data[si + 1]);
          expect(canvas.data[ci + 2]).toBe(img.data[si + 2]);
        }
      }
    }
    // 字节幂等：同输入重复编码字节一致
    const again = packCanvas('FORM_1_STANDARD_STRIP', units, {
      packetId: 1,
      appliedIntentId: 'intent_1',
      renderVisualId: false,
      triggerPath: 'DETERMINISTIC',
    });
    expect(again.imageBytes.equals(artifact.imageBytes)).toBe(true);
    expect(again.packet.stripSha256).toBe(artifact.packet.stripSha256);
    expect(again.anchorBytes?.equals(artifact.anchorBytes ?? Buffer.alloc(0))).toBe(true);
  });

  it('e2e 确定性：同参数两次检视，画布 SHA 与提示行完全一致', async () => {
    const probe = await probeVideo('test/fixtures/media/case04_plain.mp4', {
      ffprobePath: bins.ffprobe,
    });
    const opts = {
      ffmpegPath: bins.ffmpeg,
      renderVisualId: true,
      packetIdStart: 1,
      globalIdStart: 1,
      appliedIntentId: 'intent_1',
    } as const;
    const intent = { action: 'uniform', interval_ms: 500, max_packets: 2 };
    const a = await runDeterministicInspection('test/fixtures/media/case04_plain.mp4', probe, intent, opts);
    const b = await runDeterministicInspection('test/fixtures/media/case04_plain.mp4', probe, intent, opts);
    expect(a.packets.map((p) => p.packet.stripSha256)).toEqual(b.packets.map((p) => p.packet.stripSha256));
    expect(a.hintLines).toEqual(b.hintLines);
    expect(a.sampledPtsMs).toEqual(b.sampledPtsMs);
  });
});
