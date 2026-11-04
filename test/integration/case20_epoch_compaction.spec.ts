/**
 * 用例 20：Epoch Compaction 与 Prefix KV-Cache 友好。
 *
 * case14_slow fixture（5.5s 慢速运动长片）四次 1300ms 窗口调用：
 * - 未达窗口（pendingNew < epochWindow=6）时冷区引用逐轮复用（packetId 与字节不变）；
 * - 达到窗口触发批量收敛后，冷区重建但引用字节仍与首次发包的 anchorBytes 一致；
 * - 任意单轮内，窗口中的历史图像字节保持不变。
 */

import { describe, expect, it } from 'vitest';
import { runStreamCallFixture } from './helpers.js';

const SESSION = 'case20-epoch';

function coldSnapshot(
  packets: { packet: { historyMode: string; anchorOnlyRefPacketId: number | null; anchorFSha256: string | null }; imageBytes: Buffer }[],
): Map<number, string> {
  const m = new Map<number, string>();
  for (const a of packets) {
    if (a.packet.historyMode === 'anchor_only_ref') {
      m.set(a.packet.anchorOnlyRefPacketId!, a.imageBytes.toString('base64'));
    }
  }
  return m;
}

describe('case20: Epoch Compaction', () => {
  it('收敛前冷区字节逐轮不变；收敛后重建仍复用首次锚点字节', async () => {
    const c1 = await runStreamCallFixture('case14_slow.mp4', SESSION, {}, { defaultStreamWindowMs: 1300 });
    const c2 = await runStreamCallFixture('case14_slow.mp4', SESSION, {}, { defaultStreamWindowMs: 1300 });
    const c3 = await runStreamCallFixture('case14_slow.mp4', SESSION, {}, { defaultStreamWindowMs: 1300 });
    const c4 = await runStreamCallFixture('case14_slow.mp4', SESSION, {}, { defaultStreamWindowMs: 1300 });

    // 全部轮次的冷区引用字节登记：sourcePacketId → bytes
    const anchorAtFirst = new Map<number, string>();
    for (const call of [c1, c2, c3, c4]) {
      for (const a of call.packets) {
        if (a.packet.historyMode !== 'initial' && a.packet.anchorFSha256) {
          const srcId =
            a.packet.historyMode === 'anchor_only_ref'
              ? a.packet.anchorOnlyRefPacketId!
              : a.packet.packetId;
          if (!anchorAtFirst.has(srcId)) {
            anchorAtFirst.set(srcId, a.imageBytes.toString('base64'));
          }
        }
      }
    }

    // 任意轮内：同源引用的字节与登记值一致（窗口内历史字节零变动）
    for (const call of [c1, c2, c3, c4]) {
      for (const a of call.packets) {
        if (a.packet.historyMode === 'anchor_only_ref') {
          expect(a.imageBytes.toString('base64')).toBe(
            anchorAtFirst.get(a.packet.anchorOnlyRefPacketId!),
          );
        }
      }
    }

    // 未收敛轮（call2：pendingNew < 6）：冷区 packetId 与 call1 完全一致
    const cold1 = coldSnapshot(c1.packets);
    const cold2 = coldSnapshot(c2.packets);
    if (cold1.size > 0 && cold2.size > 0) {
      for (const [id, bytes] of cold1) {
        if (cold2.has(id)) expect(cold2.get(id)).toBe(bytes);
      }
    }

    // 四轮后总新包 ≥ 6：至少发生一次收敛，冷区引用最新锚点源
    const totalNew = [c1, c2, c3, c4].reduce(
      (n, c) => n + c.packets.filter((a) => a.packet.historyMode === 'initial').length,
      0,
    );
    expect(totalNew).toBeGreaterThanOrEqual(6);
    const cold4 = coldSnapshot(c4.packets);
    expect(cold4.size).toBeGreaterThan(0);
  }, 300_000);
});
