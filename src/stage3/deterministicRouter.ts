/**
 * Stage 3 —— 确定性检视路由（《四、采样逻辑…》§3）。
 *
 * 旁路状态机与自闭环，复用 Stage 0（解码）与 Stage 4（视窗归一化与画布打包）：
 * - 单时间戳 / focus=detail 逐帧 → FORM_3（1F，274 Tokens，slot F 全分辨率）；
 * - uniform + focus=motion → 每 4 帧一组 FORM_2（4P 概览），余量不足 4 帧不组包；
 * - 默认 balanced → 每组前 1~3 帧 P + 组末帧 F（FORM_1 / FORM_4）；
 * - 批量退化：目标数 ≥32 且平均间隔 ≤2s → 单遍区间解码 + 最近 PTS 帧映射；
 * - 空帧回退复用最后一个有效解码帧；缺帧组按实际单元数重定形态或跳过；
 * - 解码按块推进（每块 ≤20 目标），块内帧即时打包释放，常驻内存有界。
 */

import { decodePointWithFallback, decodeRangeStreaming } from '../stage0/decoder.js';
import { billTokens, packCanvas, timelineHintLine, type PacketArtifact } from '../stage4/canvasPacker.js';
import { applyViewport, planViewport } from '../stage4/viewport.js';
import { assertCanvasTokenLegal, encodedSizeOf } from '../stage6/precheck.js';
import { PfStreamError } from '../errors.js';
import type { RgbImage } from '../utils/image.js';
import type { IntentDirective, ProbeResult } from '../types.js';
import type { UnitInput } from '../stage4/canvasPacker.js';

export interface RouterOptions {
  ffmpegPath: string;
  ffprobePath?: string | undefined;
  renderVisualId: boolean;
  packetIdStart: number;
  globalIdStart: number;
  appliedIntentId: string;
  /** 请求字节水位（Base64 后口径；缺省不校验）。规格《六》§2 对 PATH_DETERMINISTIC 同样生效。 */
  maxRequestBytes?: number | undefined;
  /** 单图视觉 Token 上限（meteringProfile 口径；缺省不校验）。 */
  maxTokensPerImage?: number | undefined;
  /** 单次调用视觉 Token 预算（意图层 max_tokens_budget，规格《五》§1.3；缺省不校验）。 */
  maxTokensBudget?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface InspectionResult {
  packets: PacketArtifact[];
  hintLines: string[];
  /** 实际抽帧 PTS 序列（毫秒，排序去重后）。 */
  sampledPtsMs: number[];
}

/** 单块解码目标数上限：限制批量解码常驻内存（≤20 帧全分辨率）。 */
const CHUNK_TARGETS = 20;

/** 目标 PTS 列表推导：排序、去重、钳制。 */
export function resolveTargets(
  intent: IntentDirective,
  probe: ProbeResult,
): number[] {
  const last = probe.lastPtsMs;
  if (intent.action === 'timestamps') {
    const list = (intent.timestamps_ms ?? []).map((t) => Math.min(Math.max(Math.round(t), 0), last));
    return dedupeSorted(list.sort((a, b) => a - b));
  }
  // uniform
  const w0raw = intent.pts_window?.[0] ?? 0;
  const w1raw = intent.pts_window?.[1] ?? last;
  const w0 = Math.min(Math.max(Math.round(Math.min(w0raw, w1raw)), 0), last);
  const w1 = Math.min(Math.max(Math.round(Math.max(w0raw, w1raw)), 0), last);
  const out: number[] = [];
  if (intent.frame_count != null && intent.frame_count >= 1) {
    if (intent.frame_count === 1) return [w0];
    const step = (w1 - w0) / (intent.frame_count - 1);
    for (let i = 0; i < intent.frame_count; i++) out.push(Math.round(w0 + step * i));
  } else if (intent.interval_ms != null && intent.interval_ms > 0) {
    for (let t = w0; t <= w1; t += intent.interval_ms) out.push(Math.round(t));
  } else {
    throw new PfStreamError(
      'PFSTREAM_UNIFORM_PARAMS_MISSING',
      'uniform 抽帧需要 interval_ms 或 frame_count 之一',
    );
  }
  return dedupeSorted(out.map((t) => Math.min(t, last)));
}

function dedupeSorted(list: number[]): number[] {
  const out: number[] = [];
  for (const t of list) {
    if (out.length === 0 || out[out.length - 1] !== t) out.push(t);
  }
  return out;
}

/** 批量退化判定。 */
export function shouldBatchDecode(targets: number[]): boolean {
  if (targets.length < 32) return false;
  const span = targets[targets.length - 1]! - targets[0]!;
  const avgGap = span / (targets.length - 1);
  return avgGap <= 2000;
}

interface GroupPlan {
  form: 'FORM_1_STANDARD_STRIP' | 'FORM_2_COMPACT_4P' | 'FORM_3_COMPACT_1F' | 'FORM_4_PARTIAL_STRIP';
  pCount: number;
  hasF: boolean;
}

/** 分组与形态规划。 */
export function planGroups(
  targets: number[],
  focus: IntentDirective['focus'],
  singleTimestamp: boolean,
): GroupPlan[] {
  const detailMode = focus === 'detail' || singleTimestamp;
  if (detailMode) {
    return targets.map(() => ({ form: 'FORM_3_COMPACT_1F' as const, pCount: 0, hasF: true }));
  }
  if (focus === 'motion') {
    // 每 4 帧一组 FORM_2；余量不足 4 帧不组包。
    const fullGroups = Math.floor(targets.length / 4);
    const groups: GroupPlan[] = [];
    for (let g = 0; g < fullGroups; g++) {
      groups.push({ form: 'FORM_2_COMPACT_4P', pCount: 4, hasF: false });
    }
    return groups;
  }
  // balanced：每组 5 帧满组（前 4 帧 P + 组末帧 F → FORM_1）；
  // 余组 2~4 帧（前 k-1 帧 P + 组末帧 F → FORM_4），单帧余量 → FORM_3
  const groups: GroupPlan[] = [];
  for (let i = 0; i < targets.length; i += 5) {
    const n = Math.min(5, targets.length - i);
    if (n === 1) {
      groups.push({ form: 'FORM_3_COMPACT_1F', pCount: 0, hasF: true });
    } else if (n === 5) {
      groups.push({ form: 'FORM_1_STANDARD_STRIP', pCount: 4, hasF: true });
    } else {
      groups.push({ form: 'FORM_4_PARTIAL_STRIP', pCount: n - 1, hasF: true });
    }
  }
  return groups;
}

/** 按实际单元集合重定形态；无法成立时返回 null（跳过该组）。 */
function selectForm(units: UnitInput[]): GroupPlan['form'] | null {
  let fCount = 0;
  for (const u of units) if (u.scale === '2x2_F') fCount++;
  const pCount = units.length - fCount;
  if (fCount === 1) {
    if (pCount === 0) return 'FORM_3_COMPACT_1F';
    if (pCount === 4) return 'FORM_1_STANDARD_STRIP';
    if (pCount >= 1) return 'FORM_4_PARTIAL_STRIP';
    return null;
  }
  if (fCount === 0 && pCount === 4) return 'FORM_2_COMPACT_4P';
  return null;
}

/** 执行确定性检视。 */
export async function runDeterministicInspection(
  videoPath: string,
  probe: ProbeResult,
  intent: IntentDirective,
  options: RouterOptions,
): Promise<InspectionResult> {
  const targets = resolveTargets(intent, probe);
  if (targets.length === 0) {
    return { packets: [], hintLines: [], sampledPtsMs: [] };
  }

  const decodeOptions = {
    ffmpegPath: options.ffmpegPath,
    ffprobePath: options.ffprobePath,
    displayWidth: probe.displayWidth,
    displayHeight: probe.displayHeight,
    signal: options.signal,
  };

  const groups = planGroups(targets, intent.focus, targets.length === 1 && intent.action === 'timestamps');

  // 组 → 目标区间（组按顺序连续消耗 targets）
  interface Span {
    start: number;
    count: number;
    plan: GroupPlan;
  }
  const spans: Span[] = [];
  let ti = 0;
  for (const plan of groups) {
    const count = plan.pCount + (plan.hasF ? 1 : 0);
    spans.push({ start: ti, count, plan });
    ti += count;
  }

  const packets: PacketArtifact[] = [];
  // 提示行（let：字节水位截断时需同步移除对应行）
  let hintLines: string[] = [];
  let globalId = options.globalIdStart;
  let packetId = options.packetIdStart;
  /** 已发出画布包的计费 Token 累计（意图层预算判定）。 */
  let usedTokens = 0;
  const sampled: number[] = [];

  // 按块推进：每块 ≤CHUNK_TARGETS 个目标，块内帧打包后即释放，内存有界
  let spanIdx = 0;
  while (spanIdx < spans.length) {
    const chunk: Span[] = [];
    let used = 0;
    while (spanIdx < spans.length && used < CHUNK_TARGETS) {
      const s = spans[spanIdx]!;
      chunk.push(s);
      used += s.count;
      spanIdx++;
    }
    const chunkStart = chunk[0]!.start;
    const chunkTargets = targets.slice(chunkStart, chunkStart + used);

    const frames = new Map<number, RgbImage>();
    if (shouldBatchDecode(chunkTargets)) {
      const best = new Map<number, { dist: number; image: RgbImage }>();
      let firstUnfinalized = 0;
      await decodeRangeStreaming(
        videoPath,
        chunkTargets[0]!,
        chunkTargets[chunkTargets.length - 1]!,
        decodeOptions,
        (image, ptsMs) => {
          // 帧按 PTS 升序到达：越过目标即定稿
          while (firstUnfinalized < chunkTargets.length && ptsMs > chunkTargets[firstUnfinalized]!) {
            const t = chunkTargets[firstUnfinalized]!;
            const hit = best.get(t);
            if (hit) frames.set(t, hit.image);
            firstUnfinalized++;
          }
          for (let j = firstUnfinalized; j < Math.min(chunkTargets.length, firstUnfinalized + 8); j++) {
            const t = chunkTargets[j]!;
            const dist = Math.abs(ptsMs - t);
            const prev = best.get(t);
            if (!prev || dist < prev.dist) best.set(t, { dist, image });
          }
        },
      );
      for (let j = firstUnfinalized; j < chunkTargets.length; j++) {
        const t = chunkTargets[j]!;
        const hit = best.get(t);
        if (hit) frames.set(t, hit.image);
      }
    } else {
      let lastValid: RgbImage | null = null;
      for (const target of chunkTargets) {
        const frame = await decodePointWithFallback(
          videoPath,
          target,
          probe.lastPtsMs,
          decodeOptions,
          lastValid,
        );
        lastValid = frame;
        frames.set(target, frame);
      }
    }

    // 打包本块各组（缺帧单元跳过，按实际单元数重定形态）
    for (const span of chunk) {
      const units: UnitInput[] = [];
      const groupTargets = targets.slice(span.start, span.start + span.count);
      for (let i = 0; i < groupTargets.length; i++) {
        const isF = span.plan.hasF && i === groupTargets.length - 1;
        const pts = groupTargets[i]!;
        const frame = frames.get(pts);
        if (!frame) continue;
        const plan = planViewport({
          displayWidth: probe.displayWidth,
          displayHeight: probe.displayHeight,
          roi: intent.roi_hint,
          fullFrame: intent.full_frame === true,
          slot: isF ? 'F' : 'P',
        });
        units.push({
          globalId: globalId++,
          ptsMs: pts,
          scale: isF ? '2x2_F' : '1x1_P',
          eventType: 'DETERMINISTIC',
          image: applyViewport(frame, plan, isF ? 'F' : 'P'),
          sourceCropBbox: plan.sourceCropBbox,
        });
        sampled.push(pts);
      }
      const form = selectForm(units);
      if (units.length === 0 || form === null) continue;
      const artifact = packCanvas(form, units, {
        packetId: packetId++,
        appliedIntentId: options.appliedIntentId,
        renderVisualId: options.renderVisualId,
        triggerPath: 'DETERMINISTIC',
      });
      // 意图层预算（规格《五》§1.3）：即将超限的本包不发出，提前结束本次调用
      // （与 pf_stream 通道 budget_tokens 同语义；首包即超限时返回空结果）。
      // 预算源：RouterOptions 显式传入优先，否则回读意图层 max_tokens_budget
      // （入口适配器已按配置上限钳制，与 intent.max_packets 同模式）。
      const cost = billTokens(artifact.packet.canvasSize[0], artifact.packet.canvasSize[1]);
      const budget = options.maxTokensBudget ?? intent.max_tokens_budget;
      if (budget !== undefined && usedTokens + cost > budget) {
        spanIdx = spans.length;
        break;
      }
      usedTokens += cost;
      packets.push(artifact);
      hintLines.push(timelineHintLine(artifact.packet, intent.roi_hint ?? null));
      if (intent.max_packets != null && packets.length >= intent.max_packets) {
        spanIdx = spans.length;
        break;
      }
    }
  }

  // 预检（规格《六》§2 对 PATH_DETERMINISTIC 同样生效）：
  // 单图 Token 上限逐包校验（违规即错误）；字节水位超限从尾部截断增量包。
  if (options.maxTokensPerImage !== undefined) {
    for (const p of packets) assertCanvasTokenLegal(p, options.maxTokensPerImage);
  }
  if (options.maxRequestBytes !== undefined) {
    let total = packets.reduce((acc, p) => acc + encodedSizeOf(p.imageBytes), 0);
    while (total > options.maxRequestBytes && packets.length > 0) {
      const last = packets.pop()!;
      total -= encodedSizeOf(last.imageBytes);
      hintLines = hintLines.filter((l) => !l.includes(`Packet #${last.packet.packetId} `));
    }
  }

  return { packets, hintLines, sampledPtsMs: dedupeSorted(sampled) };
}
