/** A6/A10：跨包缝合挂载与 assistFocus 触发判定。 */
import { describe, expect, it } from 'vitest';
import {
  audioHintLine,
  assistFocusShouldFire,
  coldRefAudioHintLine,
  mountSegments,
  type PacketWindow,
} from '../../../src/audio/sidecar.js';
import type { TranscriptSegment } from '../../../src/audio/types.js';

const seg = (id: number, startMs: number, endMs: number, text: string): TranscriptSegment => ({
  segId: id, startMs, endMs, text, source: 'asr',
});

const packet = (packetId: number, startMs: number, endMs: number, units: Array<[number, number]> = []): PacketWindow => ({
  packetId, startMs, endMs,
  unitIds: units.map(([globalId, timestampMs]) => ({ globalId, timestampMs })),
});

describe('A6 跨包缝合挂载', () => {
  it('重叠最大归属；跨包段 (cont.) 副本；±300ms 单元锚定', () => {
    // 段 1100–1900 横跨包边界 1500，两包重叠并列（700ms）→ 归较早的包 1
    const segs = [seg(1, 1100, 1900, '跨包台词'), seg(2, 3000, 3400, '后包台词')];
    const mounts = mountSegments(
      [packet(1, 0, 1500, [[101, 1300]]), packet(2, 1500, 4000, [[102, 3100]])],
      segs,
      'ok',
      'asr',
      null,
    );
    expect(mounts.size).toBe(2);
    const m1 = mounts.get(1)!;
    const m2 = mounts.get(2)!;
    expect(m1.segments.map((s) => `${s.segId}:${s.text}`)).toEqual(['1:跨包台词']);
    expect(m2.segments.map((s) => `${s.segId}:${s.text}`)).toEqual(['1:(cont.) 跨包台词', '2:后包台词']);
    // 主归属全文唯一（(cont.) 为副本，不计入唯一性）
    const owners = [m1, m2]
      .map((m) => m.segments.filter((s) => !s.text.startsWith('(cont.)')).map((s) => s.segId))
      .flat();
    expect(new Set(owners).size).toBe(owners.length);
    expect(m1.segments[0]?.alignedUnitIds).toEqual([101]);
    expect(m2.segments.find((s) => s.segId === 2)?.alignedUnitIds).toEqual([102]);
  });

  it('主归属取重叠最大的包（并列归较早）', () => {
    // 段 1000–2600：包 1 重叠 800ms，包 2 重叠 1400ms → 归包 2，包 1 不留副本（段早于包 2 窗口起点但包 1 窗口更早）
    const segs = [seg(1, 1000, 2600, '大段')];
    const mounts = mountSegments(
      [packet(1, 0, 1500), packet(2, 1500, 4000, [[201, 2000]])],
      segs,
      'ok',
      'asr',
      null,
    );
    expect(mounts.get(1)).toBeUndefined();
    expect(mounts.get(2)?.segments.map((s) => s.text)).toEqual(['大段']);
  });

  it('非归属包重叠 <150ms 不留副本；无交集/空输入返回空', () => {
    // 段 1200–1300 完全落在包 1，包 2 仅 margin 内 100ms
    const segs = [seg(1, 1200, 1300, '短段')];
    const mounts = mountSegments(
      [packet(1, 0, 1500), packet(2, 1500, 4000)],
      segs,
      'ok',
      'asr',
      null,
    );
    expect(mounts.size).toBe(1);
    expect(mounts.get(2)).toBeUndefined();
    expect(mountSegments([], segs, 'ok', 'asr', null).size).toBe(0);
    expect(mountSegments([packet(1, 0, 1000)], [], 'ok', 'asr', null).size).toBe(0);
    const far = mountSegments([packet(1, 5000, 6000)], [seg(1, 0, 1000, '远处')], 'ok', 'asr', null);
    expect(far.size).toBe(0);
  });

  it('提示行格式：最多 3 段 + more 计数；冷区保留行', () => {
    const mount = {
      status: 'ok' as const, source: 'asr' as const, language: null,
      segments: [
        { ...seg(1, 12_100, 12_900, '甲'), alignedUnitIds: [1] },
        { ...seg(2, 13_000, 13_400, '乙'), alignedUnitIds: [2] },
        { ...seg(3, 14_000, 14_400, '丙'), alignedUnitIds: [3] },
        { ...seg(4, 15_000, 15_400, '丁'), alignedUnitIds: [4] },
      ],
    };
    expect(audioHintLine(42, mount)).toBe(
      'Audio @Packet #42: [12.1s-12.9s] "甲" | [13.0s-13.4s] "乙" | [14.0s-14.4s] "丙" …(+1 more)',
    );
    expect(coldRefAudioHintLine(42, 3)).toBe('[Audio@#42] 3 segments retained');
  });
});

describe('A10 assistFocus 触发判定', () => {
  const ctx = { islands: [[10_000, 13_000] as [number, number]], speechRate: 6 };

  it('满足全部条件时触发（岛结束后 0.4–5s 停顿谷底）', () => {
    expect(assistFocusShouldFire(ctx, 15_000, 4_000, null, 0.2, null)).toBe(13_000);
  });

  it('STATIC 不足 10s / 距上 F <3s / Σd<0.15 不触发', () => {
    expect(assistFocusShouldFire(ctx, 15_000, 6_000, null, 0.2, null)).toBeNull();
    expect(assistFocusShouldFire(ctx, 15_000, 4_000, 13_500, 0.2, null)).toBeNull();
    expect(assistFocusShouldFire(ctx, 15_000, 4_000, null, 0.1, null)).toBeNull();
  });

  it('停顿窗外（<0.4s 或 >5s）不触发；同岛只触发一次', () => {
    expect(assistFocusShouldFire(ctx, 13_100, 4_000, null, 0.2, null)).toBeNull();
    expect(assistFocusShouldFire(ctx, 20_000, 4_000, null, 0.2, null)).toBeNull();
    expect(assistFocusShouldFire(ctx, 15_000, 4_000, null, 0.2, 13_000)).toBeNull();
  });

  it('短岛且语速低不视为密集岛', () => {
    const sparse = { islands: [[10_000, 11_000] as [number, number]], speechRate: 3 };
    expect(assistFocusShouldFire(sparse, 13_000, 4_000, null, 0.2, null)).toBeNull();
  });

  it('同输入双跑幂等', () => {
    const a = assistFocusShouldFire(ctx, 15_000, 4_000, null, 0.2, null);
    const b = assistFocusShouldFire(ctx, 15_000, 4_000, null, 0.2, null);
    expect(a).toBe(b);
  });
});
