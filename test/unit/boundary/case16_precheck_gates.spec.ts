/**
 * 用例 16（boundary）：4096px 不变量与可配置门控 + 预检截断顺序 + 56MiB 水位。
 *
 * 纯逻辑测试：合成 PacketArtifact，不依赖视频 fixture。
 * 覆盖：规格《六》§2 15 图 4096px 门控、截断顺序（冷区旧→新 → 热区旧→新 →
 * 增量尾部）、56MiB 软水位（含 Base64 4/3 膨胀预留）、计费公式复算。
 */

import { describe, expect, it } from 'vitest';
import {
  encodedSizeOf,
  MAX_CANVAS_EDGE_PX,
  precheckBundle,
  type BundleItem,
} from '../../../src/stage6/precheck.js';
import type { PacketArtifact } from '../../../src/stage4/canvasPacker.js';
import type { CanvasPacket, UnitDescriptor } from '../../../src/types.js';

let nextId = 1;

function unit(globalId: number, eventType: UnitDescriptor['eventType']): UnitDescriptor {
  return {
    globalId,
    timestampMs: globalId * 200,
    scale: eventType === 'DETERMINISTIC' || eventType === 'SETTLE' ? '2x2_F' : '1x1_P',
    eventType,
    tokenGridBbox: [0, 0, 8, 8],
    contentPixelBbox: [0, 0, 336, 336],
    sourceCropBbox: [0, 0, 336, 336],
  };
}

function syntheticArtifact(
  canvasSize: [number, number],
  byteLen: number,
  withF: boolean,
): PacketArtifact {
  const id = nextId++;
  const packet: CanvasPacket = {
    packetId: id,
    canvasSize,
    layoutForm: withF ? 'FORM_1_STANDARD_STRIP' : 'FORM_2_COMPACT_4P',
    triggerPath: 'SETTLE',
    historyMode: 'initial',
    anchorOnlyRefPacketId: null,
    spatialRemap: null,
    anchorFId: withF ? id * 10 : null,
    anchorFSha256: withF ? 'a'.repeat(64) : null,
    stripSha256: 'b'.repeat(64),
    appliedIntentId: 'intent_1',
    appliedCtrlId: [],
    units: [unit(id, withF ? 'SETTLE' : 'MOTION')],
  };
  const bytes = Buffer.alloc(byteLen, 7);
  return { packet, imageBytes: bytes, anchorBytes: withF ? Buffer.alloc(1024, 9) : null };
}

describe('case16: 4096px 不变量与可配置门控（precheck 纯逻辑）', () => {
  it('15 图边界合规：所有画布单边 ≤4096px 时 15 图请求全量放行', () => {
    const items: BundleItem[] = Array.from({ length: 15 }, () => ({
      kind: 'new' as const,
      artifact: syntheticArtifact([1344, 672], 4096, true),
    }));
    const r = precheckBundle(items, {
      maxRequestBytes: 56 * 1024 * 1024,
      maxPackets: 64,
      maxTokensBudget: 65536,
      imageCountTiersEnabled: false,
    });
    expect(r.kept).toHaveLength(15);
    expect(r.dropped).toHaveLength(0);
    expect(r.truncatedCurrent).toBe(false);
  });

  it('单边超 4096px 的画布在默认配置下被拒绝（PFSTREAM_CANVAS_EDGE_OVER_LIMIT）', () => {
    const items: BundleItem[] = [
      { kind: 'new', artifact: syntheticArtifact([5000, 672], 4096, true) },
    ];
    let caught: { code?: string } | null = null;
    try {
      precheckBundle(items, {
        maxRequestBytes: 56 * 1024 * 1024,
        maxPackets: 64,
        maxTokensBudget: 65536,
        imageCountTiersEnabled: false,
      });
    } catch (e) {
      caught = e as { code?: string };
    }
    expect(caught?.code).toBe('PFSTREAM_CANVAS_EDGE_OVER_LIMIT');
  });

  it('imageCountTiersEnabled=true 时超限画布放行（门控语义：规则不由插件硬编码）', () => {
    const items: BundleItem[] = [
      { kind: 'new', artifact: syntheticArtifact([5000, 672], 4096, true) },
    ];
    const r = precheckBundle(items, {
      maxRequestBytes: 56 * 1024 * 1024,
      maxPackets: 64,
      maxTokensBudget: 65536,
      imageCountTiersEnabled: true,
    });
    expect(r.kept).toHaveLength(1);
  });

  it('合法上限常量 = 4096', () => {
    expect(MAX_CANVAS_EDGE_PX).toBe(4096);
  });
});

describe('case16: 预检截断顺序与 56MiB 水位', () => {
  function bundle(): BundleItem[] {
    return [
      { kind: 'cold', artifact: syntheticArtifact([672, 672], 8192, true) }, // 最旧冷区
      { kind: 'cold', artifact: syntheticArtifact([672, 672], 8192, true) },
      { kind: 'cold', artifact: syntheticArtifact([672, 672], 8192, true) },
      { kind: 'hot', artifact: syntheticArtifact([1344, 672], 16384, true) }, // 最旧热区
      { kind: 'hot', artifact: syntheticArtifact([1344, 672], 16384, true) },
      { kind: 'new', artifact: syntheticArtifact([1344, 672], 16384, true) },
      { kind: 'new', artifact: syntheticArtifact([1344, 672], 16384, true) },
      { kind: 'new', artifact: syntheticArtifact([1344, 672], 16384, true) }, // 增量尾部
    ];
  }

  it('包数超限：从旧冷区开始丢弃，其次旧热区，最后增量尾部', () => {
    const r = precheckBundle(bundle(), {
      maxRequestBytes: 56 * 1024 * 1024,
      maxPackets: 6,
      maxTokensBudget: 65536,
      imageCountTiersEnabled: false,
    });
    expect(r.kept).toHaveLength(6);
    // 丢弃顺序：最旧冷区 → 次旧冷区 →（未到）热区/增量
    expect(r.dropped.map((d) => d.kind)).toEqual(['cold', 'cold']);
    const d0 = r.dropped[0]!;
    const d1 = r.dropped[1]!;
    expect(d0.packetId).toBeLessThan(d1.packetId);
    // 保留下来的顺序与原相对顺序一致
    expect(r.kept.map((k) => k.kind)).toEqual(['cold', 'hot', 'hot', 'new', 'new', 'new']);
    // 仅丢冷/热时增量未被切分
    expect(r.truncatedCurrent).toBe(false);
  });

  it('字节水位按 Base64 编码后口径（4/3 膨胀）截断', () => {
    // 3 × 16384B 原始 → 编码后 21846B/张；水位 50000B 只容 2 张
    const items: BundleItem[] = Array.from({ length: 3 }, () => ({
      kind: 'new' as const,
      artifact: syntheticArtifact([1344, 672], 16384, true),
    }));
    const r = precheckBundle(items, {
      maxRequestBytes: 50_000,
      maxPackets: 64,
      maxTokensBudget: 65536,
      imageCountTiersEnabled: false,
    });
    expect(encodedSizeOf(Buffer.alloc(16384))).toBe(Math.ceil((16384 * 4) / 3));
    expect(r.kept).toHaveLength(2);
    expect(r.dropped.map((d) => d.kind)).toEqual(['new']); // 增量尾部
  });

  it('Token 预算超限同样触发截断且计费公式复算一致', () => {
    const r = precheckBundle(bundle(), {
      maxRequestBytes: 56 * 1024 * 1024,
      maxPackets: 64,
      maxTokensBudget: 530 * 3,
      imageCountTiersEnabled: false,
    });
    // 全部条目按 FORM_1（530 Tokens）计费：预算 1590 → 保留 3
    expect(r.tokens).toBe(530 * 3);
    expect(r.kept).toHaveLength(3);
  });
});
