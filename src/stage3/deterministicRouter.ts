/**
 * Stage 3 —— 确定性检视路由（《四、采样逻辑…》§3）。
 *
 * 旁路状态机与自闭环，复用 Stage 0（解码）与 Stage 4（视窗归一化与画布打包）：
 * - 单时间戳 / focus=detail 逐帧 → FORM_3（1F，274 Tokens，slot F 全分辨率）；
 * - uniform + focus=motion → 每 4 帧一组 FORM_2（4P 概览）；
 * - 默认 balanced → 每组前 1~3 帧 P + 组末帧 F（FORM_1 / FORM_4）；
 * - 批量退化：目标数 ≥32 且平均间隔 ≤2s → 单遍区间解码 + 最近 PTS 帧映射；
 * - 空帧回退复用最后一个有效解码帧。
 */

import { decodePointWithFallback, decodeRange } from '../stage0/decoder.js';
import { packCanvas, timelineHintLine, type PacketArtifact } from '../stage4/canvasPacker.js';
import { applyViewport, planViewport } from '../stage4/viewport.js';
import type { RgbImage } from '../utils/image.js';
import type { IntentDirective, ProbeResult } from '../types.js';
import type { UnitInput } from '../stage4/canvasPacker.js';

export interface RouterOptions {
  ffmpegPath: string;
  renderVisualId: boolean;
  packetIdStart: number;
  globalIdStart: number;
  appliedIntentId: string;
  signal?: AbortSignal | undefined;
}

export interface InspectionResult {
  packets: PacketArtifact[];
  hintLines: string[];
  /** 实际抽帧 PTS 序列（毫秒，排序去重后）。 */
  sampledPtsMs: number[];
}

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
    out.push(w0);
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
    const groups: GroupPlan[] = [];
    for (let i = 0; i < targets.length; i += 4) {
      groups.push({ form: 'FORM_2_COMPACT_4P', pCount: Math.min(4, targets.length - i), hasF: false });
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
    displayWidth: probe.displayWidth,
    displayHeight: probe.displayHeight,
    signal: options.signal,
  };

  // 解码：批量退化或逐点
  const frames = new Map<number, RgbImage>();
  if (shouldBatchDecode(targets)) {
    const range = await decodeRange(videoPath, targets[0]!, targets[targets.length - 1]!, {
      ...decodeOptions,
    });
    for (const target of targets) {
      let best = range[0];
      let bestDist = Number.POSITIVE_INFINITY;
      for (const f of range) {
        const dist = Math.abs(f.ptsMs - target);
        if (dist < bestDist) {
          best = f;
          bestDist = dist;
        }
      }
      if (best) frames.set(target, best.image);
    }
  } else {
    let lastValid: RgbImage | null = null;
    for (const target of targets) {
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

  // 视窗计划（同组共享源帧参数，槽位不同）
  const groups = planGroups(targets, intent.focus, targets.length === 1 && intent.action === 'timestamps');
  const packets: PacketArtifact[] = [];
  const hintLines: string[] = [];
  let globalId = options.globalIdStart;
  let packetId = options.packetIdStart;
  let targetIdx = 0;

  for (const group of groups) {
    const units: UnitInput[] = [];
    const groupTargets = targets.slice(targetIdx, targetIdx + group.pCount + (group.hasF ? 1 : 0));
    for (let i = 0; i < groupTargets.length; i++) {
      const isF = group.hasF && i === groupTargets.length - 1;
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
    }
    targetIdx += groupTargets.length;
    if (units.length === 0) continue;
    const artifact = packCanvas(group.form, units, {
      packetId: packetId++,
      appliedIntentId: options.appliedIntentId,
      renderVisualId: options.renderVisualId,
      triggerPath: 'DETERMINISTIC',
    });
    packets.push(artifact);
    hintLines.push(timelineHintLine(artifact.packet, intent.roi_hint ?? null));
    if (intent.max_packets != null && packets.length >= intent.max_packets) break;
  }

  return { packets, hintLines, sampledPtsMs: targets };
}
