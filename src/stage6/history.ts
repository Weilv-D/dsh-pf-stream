/**
 * Stage 6（两级历史引用）—— 热区全条带引用 / 冷区锚点引用 / Epoch Compaction。
 *
 * 规格《六、发包控制、两级历史引用与多图容量预检门控》：
 * - 热区（最近 hotWindow=2 个历史画布包）：history_mode='full_strip_ref'，
 *   原样引用首次发包的条带字节与 strip_sha256；
 * - 冷区（热区之外的带 F 锚点历史包，至多 maxColdRefs=4）：
 *   history_mode='anchor_only_ref'，以 FORM_3 独立载体（672×672，274 Tokens）引用，
 *   anchor_only_ref_packet_id 指向原始条带包，spatial_remap='anchor_to_full_canvas'；
 * - FORM_2 纯过程包与心跳包滑出热区后按纯过程包生命周期释放，不进入冷区；
 * - Epoch Compaction：冷区引用按固定窗口周期（epochWindow 新包）批量收敛，
 *   窗口内冷区引用（packetId 与字节）零变动，避免每轮滑动改写历史位置图像
 *   导致上游 Prefix KV-Cache 逐轮失效。
 *
 * F 单元双载体在 packCanvas 内生成（条带字节 + 独立载体字节），本模块只做
 * 记录、引用决策与释放；跨包引用逐字节复用，SHA-256 不变。
 */

import { billTokens } from '../stage4/canvasPacker.js';
import type { PacketArtifact } from '../stage4/canvasPacker.js';
import type {
  CanvasPacket,
  ColdRefPlan,
  EpochState,
  FUnitCacheEntry,
  HistoryEntry,
  HistoryRing,
  SessionState,
  SessionVideoState,
  UnitDescriptor,
} from '../types.js';
import type { TranscriptSegment } from '../audio/types.js';

export const HOT_WINDOW = 2;

/** 把本轮流式产物记入历史环与 FUnitCache（冷区引用与字节幂等断言的数据源）。 */
export function recordPackets(
  slot: SessionVideoState,
  session: SessionState,
  artifacts: PacketArtifact[],
  audioSegmentsByPacket?: Map<number, TranscriptSegment[]>,
): void {
  for (const a of artifacts) {
    const audioSegments = audioSegmentsByPacket?.get(a.packet.packetId);
    slot.history.packets.push({
      packet: a.packet,
      imageBytes: a.imageBytes,
      anchorBytes: a.anchorBytes,
      anchorFContentHash: a.anchorFContentHash,
      audioSegments: audioSegments !== undefined && audioSegments.length > 0 ? audioSegments : undefined,
    });
    slot.epoch.pendingNew += 1;
    if (a.packet.anchorFId != null && a.anchorBytes) {
      session.fUnitCache.set(a.packet.anchorFId, {
        anchorFId: a.packet.anchorFId,
        packetId: a.packet.packetId,
        ptsMs: a.packet.units.find((u) => u.globalId === a.packet.anchorFId)?.timestampMs ?? 0,
        independentBytes: a.anchorBytes,
        anchorFSha256: a.packet.anchorFSha256 ?? '',
        stripBytes: a.packet.layoutForm === 'FORM_3_COMPACT_1F' ? undefined : a.imageBytes,
        stripSha256: a.packet.stripSha256 ?? undefined,
        contentHash: a.anchorFContentHash ?? undefined,
      });
    }
  }
}

/** 构造冷区 FORM_3 锚点引用包（元数据按规格《七》§2 冷区示例回填）。 */
export function buildColdRefPacket(plan: ColdRefPlan, appliedIntentId: string): PacketArtifact {
  const packet: CanvasPacket = {
    packetId: plan.refPacketId,
    canvasSize: [672, 672],
    layoutForm: 'FORM_3_COMPACT_1F',
    triggerPath: 'SETTLE',
    historyMode: 'anchor_only_ref',
    anchorOnlyRefPacketId: plan.sourcePacketId,
    spatialRemap: 'anchor_to_full_canvas',
    anchorFId: plan.anchorFId,
    anchorFSha256: plan.anchorFSha256,
    stripSha256: null,
    appliedIntentId,
    appliedCtrlId: [],
    units: [
      {
        globalId: plan.anchorFId,
        timestampMs: plan.ptsMs,
        scale: '2x2_F',
        eventType: plan.eventType,
        tokenGridBbox: [0, 0, 16, 16],
        contentPixelBbox: [0, 0, 672, 672],
        sourceCropBbox: plan.sourceCropBbox,
      },
    ],
  };
  return { packet, imageBytes: plan.bytes, anchorBytes: null, anchorFContentHash: plan.contentHash ?? null };
}

/** 冷区引用提示行（规格《六》§4 冷区历史引用格式）。 */
export function coldRefHintLine(plan: ColdRefPlan): string {
  return `[Packet #${plan.refPacketId} | Ref: #${plan.sourcePacketId} | Anchor: #${plan.anchorFId} | #${plan.anchorFId}(F, ${(plan.ptsMs / 1000).toFixed(1)}s, Full-Canvas)]`;
}

/**
 * 冷区准入：热区之外的带 F 锚点历史包，从新到旧取 maxColdRefs 个。
 * 未入选者与 FORM_2/心跳类纯过程包在本轮收敛后释放（从环中移除）。
 *
 * `excludeIds`（本轮新生包）不参与准入：包的条带必须先投递过才有资格被收编
 * （「每包条带只出现一次」以先投递为前提），否则该包的 P 单元内容永不交付。
 */
export function selectColdCandidates(
  ring: HistoryEntry[],
  hotWindow: number,
  maxColdRefs: number,
  excludeIds?: ReadonlySet<number>,
): HistoryEntry[] {
  // slice(-0) === slice(0)：maxColdRefs=0（配置允许，语义为不保留冷区）
  // 会退化为全保留，必须显式拦截。
  if (maxColdRefs <= 0) return [];
  const coldZone = ring.slice(0, Math.max(0, ring.length - hotWindow));
  const anchored = coldZone.filter(
    (e) =>
      e.packet.anchorFId != null &&
      e.anchorBytes != null &&
      (!excludeIds || !excludeIds.has(e.packet.packetId)),
  );
  // 从新到旧保留 maxColdRefs 个（规格：按原始包龄从新到旧保留，超出淘汰）
  return anchored.slice(-maxColdRefs);
}

/**
 * Epoch 决策与冷区收敛。
 *
 * 每轮追加新包后调用：累计满 epochWindow 个新包（或冷区引用首次建立）时
 * 重建冷区引用并释放未入选条目；窗口内复用既有 ColdRefPlan（packetId 与
 * 字节零变动）。本轮新生包（protectIds）不收编也不释放——条带必须先随增量
 * 投递过一次，下一轮收敛才有资格进入冷区（保证「每包条带只出现一次」以
 * 「先投递后收编」为前提）。返回是否发生了收敛（recompacted）。
 */
export function compactEpoch(
  slot: SessionVideoState,
  session: SessionState,
  options: {
    hotWindow?: number;
    maxColdRefs: number;
    epochWindow: number;
    /** 本轮新生包 packetId 集合：本轮不收编、不释放（条带须先投递）。 */
    protectIds?: ReadonlySet<number>;
  },
  allocPacketId: () => number,
  appliedIntentId: string,
): boolean {
  const hotWindow = options.hotWindow ?? HOT_WINDOW;
  const ring = slot.history.packets;

  if (slot.epoch.coldRefs.length === 0 || slot.epoch.pendingNew >= options.epochWindow) {
    const keep = selectColdCandidates(ring, hotWindow, options.maxColdRefs, options.protectIds);
    const keepSet = new Set(keep.map((e) => e.packet.packetId));
    const hotSet = new Set(ring.slice(ring.length - hotWindow).map((e) => e.packet.packetId));

    // 重建冷区引用（新包龄从新到旧）；释放未入选且不在热区的条目及其缓存
    const plans: ColdRefPlan[] = [];
    for (const entry of keep) {
      const p = entry.packet;
      const fUnit = p.units.find((u) => u.globalId === p.anchorFId)!;
      const prev = slot.epoch.coldRefs.find((c) => c.sourcePacketId === p.packetId);
      plans.push(
        prev ?? {
          refPacketId: allocPacketId(),
          sourcePacketId: p.packetId,
          anchorFId: p.anchorFId!,
          anchorFSha256: p.anchorFSha256!,
          ptsMs: fUnit.timestampMs,
          eventType: fUnit.eventType,
          sourceCropBbox: fUnit.sourceCropBbox,
          bytes: entry.anchorBytes!,
          contentHash: session.fUnitCache.get(p.anchorFId!)?.contentHash,
          audioSegments: entry.audioSegments,
        },
      );
    }

    // 释放：不在保留集（冷区）、不在热区、也不在本轮保护集的条目；
    // FUnitCache 同步清理。本轮新生包（protectIds）即便滑出热区也保留在环中，
    // 其条带已随本轮增量投递，下一轮收敛起才有资格进入冷区。
    const protectSet = options.protectIds;
    const released = ring.filter(
      (e) =>
        !keepSet.has(e.packet.packetId) &&
        !hotSet.has(e.packet.packetId) &&
        (!protectSet || !protectSet.has(e.packet.packetId)),
    );
    for (const e of released) {
      if (e.packet.anchorFId != null) session.fUnitCache.delete(e.packet.anchorFId);
    }
    slot.history.packets = ring.filter(
      (e) =>
        keepSet.has(e.packet.packetId) ||
        hotSet.has(e.packet.packetId) ||
        (!!protectSet && protectSet.has(e.packet.packetId)),
    );
    slot.epoch = { pendingNew: 0, coldRefs: plans };
    return true;
  }
  return false;
}

/**
 * 清除预检字节水位截断的未投递增量包（从历史环与 FUnitCache 摘除）。
 *
 * 这些包的条带从未随增量投递（precheck 丢弃），保留在环中会让它们在下一轮
 * 收敛时获得冷区资格、被收编为 anchor_only_ref——违反「先投递后收编」不变式
 * （模型会收到指向从未见过条带的锚点引用，P 单元内容永久静默丢失）。摘除后
 * 与 FORM_2/心跳类纯过程包的释放语义一致：未投递内容不留环。
 *
 * 返回实际摘除的包数（≤ ids.size；同轮重复 id 或已释放 id 自然跳过）。
 */
export function purgeUndeliveredPackets(
  slot: SessionVideoState,
  session: SessionState,
  ids: ReadonlySet<number>,
): number {
  if (ids.size === 0) return 0;
  const removed: HistoryEntry[] = [];
  slot.history.packets = slot.history.packets.filter((e) => {
    if (ids.has(e.packet.packetId)) {
      removed.push(e);
      return false;
    }
    return true;
  });
  for (const e of removed) {
    if (e.packet.anchorFId != null) session.fUnitCache.delete(e.packet.anchorFId);
  }
  // pendingNew 计「上次收敛以来的新包数」；摘除的包不再计入收敛窗口。
  if (removed.length > 0 && slot.epoch.pendingNew >= removed.length) {
    slot.epoch.pendingNew -= removed.length;
  }
  return removed.length;
}

/** 热区引用：原条带字节原样重发，history_mode='full_strip_ref'。 */
export function hotRefArtifact(entry: HistoryEntry): PacketArtifact {
  const packet: CanvasPacket = { ...entry.packet, historyMode: 'full_strip_ref' };
  return {
    packet,
    imageBytes: entry.imageBytes,
    anchorBytes: entry.anchorBytes,
    anchorFContentHash: entry.anchorFContentHash,
  };
}

/** 组装本轮输出引用（冷区 Epoch 引用 + 热区条带），顺序：冷区旧→新、热区旧→新。 */
export function planHistoryRefs(
  slot: SessionVideoState,
  appliedIntentId: string,
): { cold: PacketArtifact[]; hot: PacketArtifact[] } {
  const ring = slot.history.packets;
  const cold = slot.epoch.coldRefs.map((plan) => buildColdRefPacket(plan, appliedIntentId));
  // 心跳为独立 JSON 消息，不入历史环（此处仅热区条带引用）
  const hot = ring
    .slice(Math.max(0, ring.length - HOT_WINDOW))
    .map((e) => hotRefArtifact(e));
  return { cold, hot };
}

/** 冷区引用的计费 Token（274/包）。 */
export function coldRefTokens(count: number): number {
  return count * billTokens(672, 672);
}
