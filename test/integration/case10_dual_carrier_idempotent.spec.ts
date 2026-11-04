/**
 * 用例 10：F 单元双载体字节幂等与原地覆盖去重。
 *
 * case05 fixture（2.5s 周期运动循环，多事件跨包）：连续两次流式调用。
 * - 冷区引用的独立载体与首次发包的 anchorBytes 逐字节一致、SHA-256 相等；
 * - 热区引用的条带载体与首次发包的 strip（imageBytes）逐字节一致；
 * - 全流无 <500ms 的重复 F 锚点（近邻去重语义）。
 */

import { describe, expect, it } from 'vitest';
import { runStreamCallFixture } from './helpers.js';

const SESSION = 'case10-dual-carrier';

describe('case10: 双载体字节幂等', () => {
  it('冷区/热区引用字节与首次发包逐字节一致；无 <500ms 双 F 锚点', async () => {
    const first = await runStreamCallFixture(
      'case05_motion.mp4',
      SESSION,
      {},
      { defaultStreamWindowMs: 2200 },
    );
    const second = await runStreamCallFixture(
      'case05_motion.mp4',
      SESSION,
      {},
      { defaultStreamWindowMs: 2200 },
    );

    // 首次调用源登记：packetId → {strip, anchor, sha}
    const sources = new Map<number, { strip: Buffer; anchor: Buffer | null; sha: string | null }>();
    for (const a of first.packets) {
      sources.set(a.packet.packetId, {
        strip: a.imageBytes,
        anchor: a.anchorBytes,
        sha: a.packet.anchorFSha256,
      });
    }

    // 第二次调用：引用类包必须逐字节复用首次字节
    const refPackets = second.packets.filter(
      (a) => a.packet.historyMode !== 'initial',
    );
    expect(refPackets.length).toBeGreaterThan(0);
    for (const a of refPackets) {
      if (a.packet.historyMode === 'anchor_only_ref') {
        const src = sources.get(a.packet.anchorOnlyRefPacketId!);
        expect(src, `冷区引用的源包 #${a.packet.anchorOnlyRefPacketId} 须在首次发包中`).toBeTruthy();
        expect(a.imageBytes.equals(src!.anchor!)).toBe(true);
        expect(a.packet.anchorFSha256).toBe(src!.sha);
      } else {
        // full_strip_ref：重发原 packetId，字节 = 首次 strip
        // （FORM_3 源包的条带即独立载体本身，stripSha256 为 null 属规格语义）
        const src = sources.get(a.packet.packetId);
        expect(src, `热区引用包 #${a.packet.packetId} 须在首次发包中`).toBeTruthy();
        expect(a.imageBytes.equals(src!.strip)).toBe(true);
        if (a.packet.layoutForm === 'FORM_1_STANDARD_STRIP' || a.packet.layoutForm === 'FORM_4_PARTIAL_STRIP') {
          expect(a.packet.stripSha256).toBeTruthy();
        }
      }
    }

    // 近邻去重：全部 F 锚点（按 anchorFId 去重——冷区引用重放同锚点）两两间距 ≥500ms
    const byAnchor = new Map<number, number>();
    for (const a of [...first.packets, ...second.packets]) {
      if (a.packet.anchorFId !== null) {
        const ts = a.packet.units.find((u) => u.scale === '2x2_F')!.timestampMs;
        if (!byAnchor.has(a.packet.anchorFId)) byAnchor.set(a.packet.anchorFId, ts);
      }
    }
    const fPts = [...byAnchor.values()].sort((x, y) => x - y);
    for (let i = 1; i < fPts.length; i++) {
      expect(fPts[i] - fPts[i - 1]).toBeGreaterThanOrEqual(500);
    }
  }, 180_000);
});
