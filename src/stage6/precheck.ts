/**
 * Stage 6（预检门控）—— 请求字节水位 / 画布边长不变量 / 预算与截断顺序。
 *
 * 规格《六》§2：
 * - 单次请求 56 MiB 安全字节水位：Base64 膨胀按 4/3 计入（预留协议结构余量）；
 * - 图像单边 ≤ 4096 px 不变量：PF-Stream 画布最大边 1344 px 天然合规；
 *   imageCountTiersEnabled（多图降档规则）默认关闭；开启时超限画布放行，
 *   由调用方的多图降档规则接管（当前产物恒 ≤1344，分支实际不可达）。
 * - 截断顺序：优先从旧到新丢弃冷区引用，其次从旧到新丢弃热区条带，
 *   最后切分当前增量包（保留时序前缀）。
 */

import { billTokens } from '../stage4/canvasPacker.js';
import type { PacketArtifact } from '../stage4/canvasPacker.js';
import { PfStreamError } from '../errors.js';

export const MAX_CANVAS_EDGE_PX = 4096;

export type BundleKind = 'cold' | 'hot' | 'new';

export interface BundleItem {
  kind: BundleKind;
  artifact: PacketArtifact;
}

export interface PrecheckOptions {
  /** 请求字节水位（编码后口径，含 Base64 膨胀）。 */
  maxRequestBytes: number;
  /** 单次请求包数上限。 */
  maxPackets: number;
  /** 视觉 Token 预算。 */
  maxTokensBudget: number;
  /** 多图降档门控（默认关）。 */
  imageCountTiersEnabled: boolean;
  /** 单图视觉 Token 上限（meteringProfile.maxTokensPerImage，缺省不校验）。 */
  maxTokensPerImage?: number | undefined;
}

export interface PrecheckResult {
  kept: BundleItem[];
  /** 按丢弃顺序记录（oldCold → oldHot → 增量尾部）。 */
  dropped: Array<{ kind: BundleKind; packetId: number }>;
  truncatedCurrent: boolean;
  encodedBytes: number;
  tokens: number;
}

/** Base64 膨胀后的请求字节估算。 */
export function encodedSizeOf(bytes: Buffer): number {
  return Math.ceil((bytes.length * 4) / 3);
}

/** 画布边长不变量（契约级防护，违规即错误而非降级）。
 *  imageCountTiersEnabled 开启时放行超限画布（由调用方多图降档规则接管）。 */
export function assertCanvasEdgeLegal(artifact: PacketArtifact, tiersEnabled: boolean): void {
  const [w, h] = artifact.packet.canvasSize;
  if (w > MAX_CANVAS_EDGE_PX || h > MAX_CANVAS_EDGE_PX) {
    if (tiersEnabled) return;
    throw new PfStreamError(
      'PFSTREAM_CANVAS_EDGE_OVER_LIMIT',
      `画布单边 ${Math.max(w, h)}px 超过 ${MAX_CANVAS_EDGE_PX}px 上限（packet #${artifact.packet.packetId}）`,
    );
  }
}

/**
 * 单图 Token 上限校验（meteringProfile.maxTokensPerImage 消费点）：
 * 计费序列 r×(c+1)+2 超过口径上限即错误——服务端会二次下采样破坏 42px 网格，
 * 属契约级违规而非可降级超预算。PF-Stream 四形态画布最大 530 Token，
 * 1024 口径下结构性合规；384 legacy 口径下 FORM_1/FORM_4 会在预检期拒绝。
 */
export function assertCanvasTokenLegal(artifact: PacketArtifact, maxTokensPerImage: number): void {
  const tokens = billTokens(artifact.packet.canvasSize[0], artifact.packet.canvasSize[1]);
  if (tokens > maxTokensPerImage) {
    throw new PfStreamError(
      'PFSTREAM_CANVAS_TOKEN_OVER_LIMIT',
      `画布计费 ${tokens} Token 超过单图上限 ${maxTokensPerImage}（packet #${artifact.packet.packetId}）`,
    );
  }
}

/**
 * 预检与截断：输入按 [cold..., hot..., new...] 顺序排列的输出项。
 * 超限时按 规格 截断顺序丢弃，返回保留集与丢弃记录。
 */
export function precheckBundle(items: BundleItem[], options: PrecheckOptions): PrecheckResult {
  for (const it of items) assertCanvasEdgeLegal(it.artifact, options.imageCountTiersEnabled);
  if (options.maxTokensPerImage !== undefined) {
    for (const it of items) assertCanvasTokenLegal(it.artifact, options.maxTokensPerImage);
  }

  const tokensOf = (a: PacketArtifact) => billTokens(a.packet.canvasSize[0], a.packet.canvasSize[1]);

  let kept = items.slice();
  const dropped: PrecheckResult['dropped'] = [];
  let truncatedCurrent = false;

  const overBudget = (): boolean =>
    kept.length > options.maxPackets ||
    kept.reduce((acc, it) => acc + tokensOf(it.artifact), 0) > options.maxTokensBudget ||
    kept.reduce((acc, it) => acc + encodedSizeOf(it.artifact.imageBytes), 0) > options.maxRequestBytes;

  if (overBudget()) {
    // ① 旧冷区引用 → ② 旧热区条带 → ③ 增量包尾部
    for (const kind of ['cold', 'hot', 'new'] as BundleKind[]) {
      while (overBudget()) {
        // 冷/热：从旧到新丢（同 kind 内最靠前的最旧）；增量：从尾部切分
        const idx =
          kind === 'new'
            ? kept.map((k) => k.kind).lastIndexOf('new')
            : kept.findIndex((k) => k.kind === kind);
        if (idx < 0) break;
        dropped.push({ kind, packetId: kept[idx]!.artifact.packet.packetId });
        kept.splice(idx, 1);
        if (kind === 'new') truncatedCurrent = true;
      }
      if (!overBudget()) break;
    }
  }

  return {
    kept,
    dropped,
    truncatedCurrent,
    encodedBytes: kept.reduce((acc, it) => acc + encodedSizeOf(it.artifact.imageBytes), 0),
    tokens: kept.reduce((acc, it) => acc + tokensOf(it.artifact), 0),
  };
}
