/**
 * 用例 11：两级历史引用流转与元数据一致性。
 *
 * case05 fixture（2.5s 周期循环）三次连续调用（同会话），每窗口含运动事件：
 * - 冷区（热窗之外）以 anchor_only_ref 引用 FORM_3 独立载体，元数据全集正确；
 * - 热区（最近 2 包）以 full_strip_ref 引用原条带；
 * - 新包 historyMode=initial；
 * - 输出顺序：冷区 → 热区 → 增量。
 */

import { describe, expect, it } from 'vitest';
import { runStreamCallFixture } from './helpers.js';
import {
  exportSessionSnapshot,
  getSessionState,
  importSessionSnapshot,
  resetMemorySessions,
  setMemorySession,
} from '../../src/session/state.js';

const SESSION = 'case11-two-tier';

describe('case11: 两级历史引用流转', () => {
  it('第三次调用输出冷/热/新三层且元数据一致', async () => {
    await runStreamCallFixture('case05_motion.mp4', SESSION, {}, { defaultStreamWindowMs: 1500 });
    await runStreamCallFixture('case05_motion.mp4', SESSION, {}, { defaultStreamWindowMs: 1500 });
    const third = await runStreamCallFixture(
      'case05_motion.mp4',
      SESSION,
      {},
      { defaultStreamWindowMs: 1000 },
    );

    const packets = third.packets.map((a) => a.packet);
    const modes = packets.map((p) => p.historyMode);

    // 三层齐备
    expect(modes).toContain('anchor_only_ref');
    expect(modes).toContain('full_strip_ref');
    expect(modes).toContain('initial');

    // 顺序：所有 cold 在所有 hot 之前，所有 hot 在所有 new 之前
    const firstHot = modes.indexOf('full_strip_ref');
    const firstNew = modes.indexOf('initial');
    const lastCold = modes.lastIndexOf('anchor_only_ref');
    expect(lastCold).toBeLessThan(firstHot);
    expect(firstHot).toBeLessThan(firstNew);

    // 冷区元数据全集
    for (const p of packets.filter((x) => x.historyMode === 'anchor_only_ref')) {
      expect(p.layoutForm).toBe('FORM_3_COMPACT_1F');
      expect(p.canvasSize).toEqual([672, 672]);
      expect(p.anchorOnlyRefPacketId).toBeGreaterThan(0);
      expect(p.spatialRemap).toBe('anchor_to_full_canvas');
      expect(p.stripSha256).toBeNull();
      expect(p.anchorFId).not.toBeNull();
      expect(p.anchorFSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.units).toHaveLength(1);
      const u = p.units[0];
      expect(u.scale).toBe('2x2_F');
      expect(u.tokenGridBbox).toEqual([0, 0, 16, 16]);
      expect(u.contentPixelBbox).toEqual([0, 0, 672, 672]);
    }

    // 热区元数据
    for (const p of packets.filter((x) => x.historyMode === 'full_strip_ref')) {
      expect(p.historyMode).toBe('full_strip_ref');
      expect(p.stripSha256).toBeTruthy();
      expect(p.anchorOnlyRefPacketId).toBeNull();
      expect(p.spatialRemap).toBeNull();
    }

    // 新包
    for (const p of packets.filter((x) => x.historyMode === 'initial')) {
      expect(p.anchorOnlyRefPacketId).toBeNull();
      expect(p.spatialRemap).toBeNull();
    }

    // 遥测
    expect(third.telemetry.precheck.kept.length).toBe(packets.length);
    expect(third.coldRefCount).toBe(
      packets.filter((p) => p.historyMode === 'anchor_only_ref').length,
    );
    expect(third.hotRefCount).toBe(
      packets.filter((p) => p.historyMode === 'full_strip_ref').length,
    );
  }, 240_000);

  it('进程重建一致性（ADR-005）：快照导出→清空→导入后续流输出与不重建完全一致', async () => {
    // 对照组：连续两次调用（不重建）
    const a1 = await runStreamCallFixture('case05_motion.mp4', 'case11-rebuild-a', {}, { defaultStreamWindowMs: 1500 });
    const a2 = await runStreamCallFixture('case05_motion.mp4', 'case11-rebuild-a', {}, { defaultStreamWindowMs: 1500 });

    // 实验组：第一次调用后导出快照，清空内存，导入重建后续流
    await runStreamCallFixture('case05_motion.mp4', 'case11-rebuild-b', {}, { defaultStreamWindowMs: 1500 });
    const snapshotJson = exportSessionSnapshot(getSessionState('case11-rebuild-b'));
    resetMemorySessions();
    setMemorySession(importSessionSnapshot(snapshotJson));
    const b2 = await runStreamCallFixture('case05_motion.mp4', 'case11-rebuild-b', {}, { defaultStreamWindowMs: 1500 });

    const digestOf = (r: typeof a2) =>
      r.packets.map((a) => ({
        packetId: a.packet.packetId,
        layoutForm: a.packet.layoutForm,
        historyMode: a.packet.historyMode,
        anchorFId: a.packet.anchorFId,
        stripSha256: a.packet.stripSha256,
        imageBytes: a.imageBytes.toString('base64'),
      }));
    expect(digestOf(b2)).toEqual(digestOf(a2));
    // 提示行与采样 PTS 一致
    expect(b2.hintLines).toEqual(a2.hintLines);
    expect(b2.nextCursor.lastConsumedPtsMs).toBe(a2.nextCursor.lastConsumedPtsMs);
    expect(b2.nextCursor.pendingPUnits.length).toBe(a2.nextCursor.pendingPUnits.length);
  }, 240_000);

  it('同会话并发调用经会话锁串行化：新包 packetId 跨调用唯一', async () => {
    const [a, b] = await Promise.all([
      runStreamCallFixture('case05_motion.mp4', 'case11-conc', { pts_window: [0, 800] }, {}),
      runStreamCallFixture('case05_motion.mp4', 'case11-conc', { pts_window: [800, 1600] }, {}),
    ]);
    // 每次调用自身输出内 packetId 唯一（预检门控契约）
    for (const r of [a, b]) {
      const own = r.packets.map((x) => x.packet.packetId);
      expect(new Set(own).size).toBe(own.length);
    }
    // 未串行化时两次调用会各自从同一序号起点分配（新包 id 重复）；热区引用
    // 重喂源包 id 属规格行为（《六》§3），故仅断言新包（initial）跨调用唯一。
    const newIds = [...a.packets, ...b.packets]
      .filter((x) => x.packet.historyMode === 'initial')
      .map((x) => x.packet.packetId);
    expect(newIds.length).toBeGreaterThan(0);
    expect(new Set(newIds).size).toBe(newIds.length);
    // 串行化证据：后完成的一次引用了先完成一次的包（full_strip_ref 存在）
    expect([...a.packets, ...b.packets].some((x) => x.packet.historyMode !== 'initial')).toBe(true);
  }, 240_000);

  it('窗口末端钳制到流末帧时 stopReason=end_of_stream', async () => {
    // case05_motion 时长 4s（lastPtsMs≈3966.67）：三次 1500ms 窗口后触底
    await runStreamCallFixture('case05_motion.mp4', 'case11-eos', {}, { defaultStreamWindowMs: 1500 });
    await runStreamCallFixture('case05_motion.mp4', 'case11-eos', {}, { defaultStreamWindowMs: 1500 });
    const third = await runStreamCallFixture('case05_motion.mp4', 'case11-eos', {}, { defaultStreamWindowMs: 1500 });
    expect(third.telemetry.window[1]).toBeGreaterThanOrEqual(3960);
    expect(third.telemetry.stopReason).toBe('end_of_stream');
    const fourth = await runStreamCallFixture('case05_motion.mp4', 'case11-eos', {}, { defaultStreamWindowMs: 1500 });
    expect(fourth.telemetry.stopReason).toBe('end_of_stream');
  }, 240_000);
});
