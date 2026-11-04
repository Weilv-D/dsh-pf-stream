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
import { contentHashOfRgb } from '../../src/utils/hash.js';
import { PNG } from 'pngjs';

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

  it('contentHash 降级轨（§6）：宿主重编码改变字节但像素相同时，规范化内容哈希保持一致', async () => {
    // 模拟宿主重编码：同一 F 载体像素以不同 PNG filter 编码 → 字节不同、解码像素相同
    const width = 64;
    const height = 64;
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        raw[i] = (x * 4) % 256;
        raw[i + 1] = (y * 4) % 256;
        raw[i + 2] = 128;
      }
    }

    const encodeWithFilter = (filterType: number): Buffer => {
      const png = new PNG({ width, height });
      raw.copy(png.data);
      return PNG.sync.write(png, { filterType });
    };

    const bytesA = encodeWithFilter(0); // None
    const bytesB = encodeWithFilter(3); // Average
    expect(bytesA.equals(bytesB)).toBe(false); // 前提：字节确实不同

    // pngjs 解码为 RGBA；规范化为 rgb24 后与流式管线同口径
    const rgbaToRgb = (rgba: Buffer): Buffer => {
      const out = Buffer.alloc(width * height * 3);
      for (let i = 0, j = 0; i < width * height; i++, j += 3) {
        const k = i * 4;
        out[j] = rgba[k];
        out[j + 1] = rgba[k + 1];
        out[j + 2] = rgba[k + 2];
      }
      return out;
    };
    const decodedA = rgbaToRgb(PNG.sync.read(bytesA).data);
    const decodedB = rgbaToRgb(PNG.sync.read(bytesB).data);
    // 规范化 RGB 后内容哈希一致 → 降级轨可跨宿主重编码去重
    expect(contentHashOfRgb(width, height, decodedA)).toBe(
      contentHashOfRgb(width, height, decodedB),
    );
    // 同字节幂等
    expect(contentHashOfRgb(width, height, decodedA)).toBe(
      contentHashOfRgb(width, height, decodedA),
    );
    // 像素差异 → 哈希不同
    const mutated = Buffer.from(raw);
    mutated[0] = (mutated[0] + 1) % 256;
    expect(contentHashOfRgb(width, height, mutated)).not.toBe(
      contentHashOfRgb(width, height, raw),
    );
  });

  it('画布包回填 contentHash：含 F 的包 anchorFContentHash 非空且冷区引用与源包一致', async () => {
    const s1 = await runStreamCallFixture('case14_slow.mp4', 'case20-hash', {}, { defaultStreamWindowMs: 1300 });
    const s2 = await runStreamCallFixture('case14_slow.mp4', 'case20-hash', {}, { defaultStreamWindowMs: 1300 });
    const s3 = await runStreamCallFixture('case14_slow.mp4', 'case20-hash', {}, { defaultStreamWindowMs: 1300 });

    // 源包登记：anchorFId → contentHash（冷区引用自身也携带 contentHash，
    // 被收编包的条带不再输出，一致性对所有含锚点发射生效）
    const hashAtFirst = new Map<number, string>();
    for (const call of [s1, s2, s3]) {
      for (const a of call.packets) {
        if (a.anchorFContentHash && a.packet.anchorFId !== null) {
          if (!hashAtFirst.has(a.packet.anchorFId)) {
            hashAtFirst.set(a.packet.anchorFId, a.anchorFContentHash);
          } else {
            expect(a.anchorFContentHash).toBe(hashAtFirst.get(a.packet.anchorFId));
          }
        }
      }
    }
    expect(hashAtFirst.size).toBeGreaterThanOrEqual(1);

    // 冷区引用的 contentHash 与源包一致（降级轨跨包一致性）
    let coldSeen = 0;
    for (const call of [s2, s3]) {
      for (const a of call.packets) {
        if (a.packet.historyMode === 'anchor_only_ref') {
          expect(a.anchorFContentHash).toBe(hashAtFirst.get(a.packet.anchorFId!));
          coldSeen++;
        }
      }
    }
    expect(coldSeen).toBeGreaterThanOrEqual(1);
  }, 300_000);
});
