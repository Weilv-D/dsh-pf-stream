/**
 * Stage 6 冷区准入与 Epoch 收敛单元：收编保护（P1-2）与 slice(-0)（P2-1）修复回归防线。
 */

import { describe, expect, it } from 'vitest';
import { compactEpoch, selectColdCandidates } from '../../../src/stage6/history.js';
import { createSessionState, getVideoSlot } from '../../../src/session/state.js';
import type { CanvasPacket, HistoryEntry } from '../../../src/types.js';

function anchoredEntry(packetId: number, ptsMs: number): HistoryEntry {
  const packet = {
    packetId,
    canvasSize: [672, 672],
    layoutForm: 'FORM_3_COMPACT_1F',
    triggerPath: 'SETTLE',
    historyMode: 'initial',
    anchorFId: packetId * 10,
    anchorFSha256: `sha-${packetId}`,
    stripSha256: null,
    appliedIntentId: 'intent_1',
    appliedCtrlId: [],
    units: [
      {
        globalId: packetId * 10,
        timestampMs: ptsMs,
        scale: '2x2_F',
        eventType: 'SETTLE',
        tokenGridBbox: [0, 0, 16, 16],
        contentPixelBbox: [0, 0, 62, 672],
        sourceCropBbox: [0, 0, 1344, 672],
      },
    ],
  } as unknown as CanvasPacket;
  return {
    packet,
    imageBytes: Buffer.alloc(8, packetId),
    anchorBytes: Buffer.alloc(8, packetId),
    anchorFContentHash: null,
  };
}

function plainEntry(packetId: number): HistoryEntry {
  const packet = {
    packetId,
    canvasSize: [672, 672],
    layoutForm: 'FORM_2_COMPACT_4P',
    triggerPath: 'PEAK',
    historyMode: 'initial',
    anchorFId: null,
    anchorFSha256: null,
    stripSha256: 's',
    appliedIntentId: 'intent_1',
    appliedCtrlId: [],
    units: [],
  } as unknown as CanvasPacket;
  return {
    packet,
    imageBytes: Buffer.alloc(8, packetId),
    anchorBytes: null,
    anchorFContentHash: null,
  };
}

describe('selectColdCandidates', () => {
  it('maxColdRefs=0：显式返回空（slice(-0) 会退化成全保留）', () => {
    const ring = [anchoredEntry(1, 0), anchoredEntry(2, 1000), anchoredEntry(3, 2000)];
    expect(selectColdCandidates(ring, 2, 0)).toEqual([]);
  });

  it('从新到旧保留 maxColdRefs 个；excludeIds 将本轮新生包排除出准入', () => {
    // 环（旧→新）：1,2,3,4；热区=末 2（3,4）；冷区准入面=1,2
    const ring = [anchoredEntry(1, 0), anchoredEntry(2, 1000), anchoredEntry(3, 2000), anchoredEntry(4, 3000)];
    expect(selectColdCandidates(ring, 2, 4).map((e) => e.packet.packetId)).toEqual([1, 2]);
    // 保护新生包 2 后，准入面只剩 1
    expect(
      selectColdCandidates(ring, 2, 4, new Set([2])).map((e) => e.packet.packetId),
    ).toEqual([1]);
  });
});

describe('compactEpoch 收编保护', () => {
  it('本轮新生包不被收编也不被释放；已投递的旧包正常收编', () => {
    const session = createSessionState('hist-protect');
    const slot = getVideoSlot(session, 'fp-a');
    // 预置已投递历史：1,2,3（旧→新）
    slot.history.packets = [anchoredEntry(1, 0), anchoredEntry(2, 1000), anchoredEntry(3, 2000)];
    slot.epoch = { pendingNew: 6, coldRefs: [] };
    // 本轮新生包 4 已随 recordPackets 推入环尾
    slot.history.packets.push(anchoredEntry(4, 3000));

    const recompacted = compactEpoch(
      slot,
      session,
      { maxColdRefs: 4, epochWindow: 6, protectIds: new Set([4]) },
      (() => {
        let id = 100;
        return () => ++id;
      })(),
      'intent_1',
    );
    expect(recompacted).toBe(true);

    // 包 4 仍在环中（未释放），且不在冷区引用源里（未收编）
    expect(slot.history.packets.some((e) => e.packet.packetId === 4)).toBe(true);
    const coldSources = slot.epoch.coldRefs.map((c) => c.sourcePacketId);
    expect(coldSources).not.toContain(4);
    // 已投递的 1、2 被收编进冷区
    expect(coldSources).toContain(1);
    expect(coldSources).toContain(2);
  });

  it('下一轮不再保护：上轮新生包获得冷区准入资格', () => {
    const session = createSessionState('hist-next-round');
    const slot = getVideoSlot(session, 'fp-b');
    // 上轮后状态：冷区含 1，环=1(冷)+2,3(热/次新)+4(上轮新生,已投递)
    slot.history.packets = [
      anchoredEntry(1, 0),
      anchoredEntry(2, 1000),
      anchoredEntry(3, 2000),
      anchoredEntry(4, 3000),
    ];
    slot.epoch = {
      pendingNew: 6,
      coldRefs: [
        {
          refPacketId: 100,
          sourcePacketId: 1,
          anchorFId: 10,
          anchorFSha256: 'sha-1',
          ptsMs: 0,
          eventType: 'SETTLE',
          sourceCropBbox: [0, 0, 1344, 672],
          bytes: Buffer.alloc(8, 1),
          contentHash: null,
          audioSegments: undefined,
        },
      ],
    };
    // 本轮新包 5、6 推入（保护集只含 5、6）；环=[1,2,3,4,5,6]，
    // 热区=末 2（5,6），冷区准入面=[1,2,3,4] → 包 4（上轮新生）本轮获准收编
    slot.history.packets.push(anchoredEntry(5, 4000), anchoredEntry(6, 5000));

    compactEpoch(
      slot,
      session,
      { maxColdRefs: 4, epochWindow: 6, protectIds: new Set([5, 6]) },
      (() => {
        let id = 100;
        return () => ++id;
      })(),
      'intent_2',
    );

    const coldSources = slot.epoch.coldRefs.map((c) => c.sourcePacketId);
    // 包 4（上轮已投递）本轮获得准入，被收编；包 5、6（本轮新生）不被收编
    expect(coldSources).toContain(4);
    expect(coldSources).not.toContain(5);
    expect(coldSources).not.toContain(6);
    // 包 4 入冷区后其条带不再随增量输出——上一轮已投递过，符合「先投递后收编」
  });

  it('protectIds 与 maxColdRefs=0 组合：冷区为空、环保留热区与新生包', () => {
    const session = createSessionState('hist-zero');
    const slot = getVideoSlot(session, 'fp-c');
    slot.history.packets = [anchoredEntry(1, 0), anchoredEntry(2, 1000), anchoredEntry(3, 2000)];
    slot.epoch = { pendingNew: 6, coldRefs: [] };
    slot.history.packets.push(anchoredEntry(4, 3000));

    compactEpoch(
      slot,
      session,
      { maxColdRefs: 0, epochWindow: 6, protectIds: new Set([4]) },
      () => 100,
      'intent_1',
    );
    expect(slot.epoch.coldRefs).toEqual([]);
    // 1、2 被释放（既非冷区也非热区也非保护），3、4 保留
    expect(slot.history.packets.map((e) => e.packet.packetId)).toEqual([3, 4]);
  });

  it('未达收敛窗口时不动环（返回 false）', () => {
    const session = createSessionState('hist-idle');
    const slot = getVideoSlot(session, 'fp-d');
    slot.history.packets = [anchoredEntry(1, 0), anchoredEntry(2, 1000)];
    slot.epoch = {
      pendingNew: 1,
      coldRefs: [
        {
          refPacketId: 100,
          sourcePacketId: 1,
          anchorFId: 10,
          anchorFSha256: 'sha-1',
          ptsMs: 0,
          eventType: 'SETTLE',
          sourceCropBbox: [0, 0, 1344, 672],
          bytes: Buffer.alloc(8, 1),
          contentHash: null,
        },
      ],
    };
    const snapshot = slot.history.packets.map((e) => e.packet.packetId);
    const recompacted = compactEpoch(
      slot,
      session,
      { maxColdRefs: 4, epochWindow: 6 },
      () => 100,
      'intent_1',
    );
    expect(recompacted).toBe(false);
    expect(slot.history.packets.map((e) => e.packet.packetId)).toEqual(snapshot);
  });
});
