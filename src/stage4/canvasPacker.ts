/**
 * Stage 4 —— 画布打包（FORM_1..4 拼合 + PNG 字节锁定）。
 *
 * 排版规则（《二、双尺度视觉单元与画布形态规范》§3）：
 * - FORM_1 1344×672：左半区 2×2 排列 4P（P1 左上/P2 右上/P3 左下/P4 右下），右半区 1F；
 * - FORM_2 672×672：2×2 排列 4P；
 * - FORM_3 672×672：1F 充满画布；
 * - FORM_4 1344×672：1~3P 按象限顺序填入，空象限中性灰，右半区 1F。
 *
 * 单元视觉标记绘制在单元图像自身（含标记的 F 像素在双载体间逐位一致）。
 */

import { createHash } from 'node:crypto';
import type { CanvasPacket, UnitDescriptor } from '../types.js';
import { composeCanvas, encodePng, type RgbImage } from '../utils/image.js';
import { drawIdBadge, drawSeparators } from './markers.js';

export type LayoutForm = CanvasPacket['layoutForm'];

export interface UnitInput {
  globalId: number;
  ptsMs: number;
  scale: '1x1_P' | '2x2_F';
  eventType: 'MOTION' | 'SETTLE' | 'SWITCH_STATIC' | 'DETERMINISTIC';
  /** 已按视窗归一化的槽位图像（336 或 672）。 */
  image: RgbImage;
  /** 源视频显示坐标系采样区域。 */
  sourceCropBbox: [number, number, number, number];
}

export interface PacketArtifact {
  packet: CanvasPacket;
  /** 画布 PNG 字节（FORM_1/2/4 = 条带载体；FORM_3 = 独立载体）。 */
  imageBytes: Buffer;
  /** F 独立载体 PNG 字节（FORM_1/4 含 F 时存在）。 */
  anchorBytes: Buffer | null;
}

export interface PackOptions {
  packetId: number;
  appliedIntentId: string;
  renderVisualId: boolean;
  /** 触发路径（确定性通道为 DETERMINISTIC）。 */
  triggerPath: CanvasPacket['triggerPath'];
}

/** 画布尺寸（宽, 高）。 */
export function canvasSizeOf(form: LayoutForm): [number, number] {
  return form === 'FORM_1_STANDARD_STRIP' || form === 'FORM_4_PARTIAL_STRIP' ? [1344, 672] : [672, 672];
}

/** 计费序列长度：r×(c+1)+2（画布尺寸为 42 倍数，整除精确）。 */
export function billTokens(width: number, height: number): number {
  const r = height / 42;
  const c = width / 42;
  return r * (c + 1) + 2;
}

function descriptor(
  unit: UnitInput,
  x: number,
  y: number,
): UnitDescriptor {
  const w = unit.image.width;
  const h = unit.image.height;
  return {
    globalId: unit.globalId,
    timestampMs: unit.ptsMs,
    scale: unit.scale,
    eventType: unit.eventType,
    tokenGridBbox: [y / 42, x / 42, (y + h) / 42, (x + w) / 42],
    contentPixelBbox: [x, y, x + w, y + h],
    sourceCropBbox: unit.sourceCropBbox,
  };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 打包一个画布包。调用方保证单元数量与形态匹配：
 * FORM_1=4P+1F，FORM_2=4P，FORM_3=1F，FORM_4=1~3P+1F。
 */
export function packCanvas(
  form: LayoutForm,
  units: UnitInput[],
  options: PackOptions,
): PacketArtifact {
  const [canvasW, canvasH] = canvasSizeOf(form);
  const placements: Array<{ x: number; y: number; image: RgbImage }> = [];
  const descriptors: UnitDescriptor[] = [];
  let anchorBytes: Buffer | null = null;
  let anchorFId: number | null = null;
  let anchorSha: string | null = null;

  const pUnits = units.filter((u) => u.scale === '1x1_P');
  const fUnits = units.filter((u) => u.scale === '2x2_F');
  const fUnit = fUnits[0] ?? null;

  // 单元标记：隔离线 + 反色角标（绘制在单元图像副本上）
  const marked = units.map((u) => {
    const image: RgbImage = { width: u.image.width, height: u.image.height, data: Buffer.from(u.image.data) };
    drawSeparators(image, [{ x: 0, y: 0, w: image.width, h: image.height }]);
    if (options.renderVisualId) drawIdBadge(image, 0, 0, u.globalId);
    return { ...u, image };
  });

  if (form === 'FORM_1_STANDARD_STRIP') {
    if (pUnits.length !== 4 || !fUnit) throw new Error('FORM_1 需要 4P+1F');
    for (let i = 0; i < 4; i++) {
      const u = marked[i]!;
      const { x, y } = { x: (i % 2) * 336, y: Math.floor(i / 2) * 336 };
      placements.push({ x, y, image: u.image });
      descriptors.push(descriptor(u, x, y));
    }
    const f = marked[4]!;
    placements.push({ x: 672, y: 0, image: f.image });
    descriptors.push(descriptor(f, 672, 0));
  } else if (form === 'FORM_2_COMPACT_4P') {
    if (pUnits.length !== 4) throw new Error('FORM_2 需要 4P');
    for (let i = 0; i < 4; i++) {
      const u = marked[i]!;
      const x = (i % 2) * 336;
      const y = Math.floor(i / 2) * 336;
      placements.push({ x, y, image: u.image });
      descriptors.push(descriptor(u, x, y));
    }
  } else if (form === 'FORM_3_COMPACT_1F') {
    if (!fUnit) throw new Error('FORM_3 需要 1F');
    const f = marked[0]!;
    placements.push({ x: 0, y: 0, image: f.image });
    descriptors.push(descriptor(f, 0, 0));
  } else {
    // FORM_4_PARTIAL_STRIP：1~3P + 1F
    if (pUnits.length < 1 || pUnits.length > 3 || !fUnit) throw new Error('FORM_4 需要 1~3P+1F');
    for (let i = 0; i < pUnits.length; i++) {
      const u = marked[i]!;
      const x = (i % 2) * 336;
      const y = Math.floor(i / 2) * 336;
      placements.push({ x, y, image: u.image });
      descriptors.push(descriptor(u, x, y));
    }
    const f = marked[marked.length - 1]!;
    placements.push({ x: 672, y: 0, image: f.image });
    descriptors.push(descriptor(f, 672, 0));
  }

  const canvas = composeCanvas(canvasW, canvasH, placements);
  const imageBytes = encodePng(canvas);

  if (fUnit) {
    anchorFId = fUnit.globalId;
    const fMarked = marked.find((u) => u.scale === '2x2_F')!;
    anchorBytes = encodePng(fMarked.image);
    anchorSha = sha256(anchorBytes);
  }

  const stripSha =
    form === 'FORM_3_COMPACT_1F' ? null : sha256(imageBytes);

  const packet: CanvasPacket = {
    packetId: options.packetId,
    canvasSize: [canvasW, canvasH],
    layoutForm: form,
    triggerPath: options.triggerPath,
    historyMode: 'initial',
    anchorOnlyRefPacketId: null,
    spatialRemap: null,
    anchorFId,
    anchorFSha256: anchorSha,
    stripSha256: stripSha,
    appliedIntentId: options.appliedIntentId,
    appliedCtrlId: [],
    units: descriptors,
  };

  return { packet, imageBytes, anchorBytes };
}

/** 时序提示行位置标签。 */
export function slotLabel(form: LayoutForm, index: number, isF: boolean): string {
  if (isF) return form === 'FORM_3_COMPACT_1F' ? 'Full-Canvas' : 'Right-Half';
  const labels = ['Left-Top', 'Right-Top', 'Left-Bottom', 'Right-Bottom'];
  return labels[index] ?? 'Left-Top';
}

/** 生成结构化时序映射提示行（首次发包 / 确定性格式）。 */
export function timelineHintLine(
  packet: CanvasPacket,
  roi?: { x: number; y: number; w: number; h: number } | null,
): string {
  const parts = packet.units.map((u, i) => {
    const t = `${(u.timestampMs / 1000).toFixed(1)}s`;
    const isF = u.scale === '2x2_F';
    const slot = slotLabel(packet.layoutForm, i, isF);
    const roiPart =
      isF && packet.triggerPath === 'DETERMINISTIC' && roi
        ? `, ROI:[${roi.x},${roi.y},${roi.w},${roi.h}]`
        : '';
    return `#${u.globalId}(${isF ? 'F' : 'P'}, ${t}${roiPart}, ${slot})`;
  });
  const body = parts.join(' -> ');
  const anchor = packet.anchorFId != null ? `Anchor: #${packet.anchorFId} | ` : '';
  const mode = packet.triggerPath === 'DETERMINISTIC' ? 'Mode: DETERMINISTIC | ' : '';
  return `[Packet #${packet.packetId} | ${mode}${anchor}${body}]`;
}
