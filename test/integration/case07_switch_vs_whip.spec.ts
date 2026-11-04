/**
 * 用例 7：硬切（SWITCH）与极速甩镜解耦。
 * fixture：case07a_hardcut.mp4（testsrc2 2s + smptebars 2s，灰度分布突变）
 *          case07b_whip.mp4（testsrc2 快速横移裁剪，画面剧变但灰度分布连续）。
 */

import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES, makeSlot, runFixtureStream } from './helpers.js';

describe('用例 7：硬切 vs 极速甩镜', () => {
  it('D_hist ≥ 0.35 → SWITCH：切换点后静态保底 FORM_3，无新旧场景混排', async () => {
    const result = await runFixtureStream('case07a_hardcut.mp4', await makeSlot(join(FIXTURES, 'case07a_hardcut.mp4')));
    const switchPackets = result.packets.filter((p) => p.packet.triggerPath === 'SWITCH_STATIC');
    expect(switchPackets.length).toBeGreaterThanOrEqual(1);
    const sp = switchPackets[0]!.packet;
    expect(sp.layoutForm).toBe('FORM_3_COMPACT_1F');
    expect(sp.units).toHaveLength(1);
    expect(sp.units[0]!.scale).toBe('2x2_F');
    expect(sp.units[0]!.timestampMs).toBeGreaterThanOrEqual(1900); // 新场景帧，非旧场景
    // 混排检查：不存在「旧场景 P（<1900）与新场景 F（>2050）同包」
    for (const { packet } of result.packets) {
      const oldP = packet.units.filter((u) => u.scale === '1x1_P' && u.timestampMs < 1900);
      const newF = packet.units.filter((u) => u.scale === '2x2_F' && u.timestampMs > 2050);
      expect(oldP.length === 0 || newF.length === 0).toBe(true);
    }
  });

  it('D_hist < 0.35 → 极速甩镜维持 MOTION，零 SWITCH', async () => {
    const result = await runFixtureStream('case07b_whip.mp4', await makeSlot(join(FIXTURES, 'case07b_whip.mp4')));
    expect(result.packets.filter((p) => p.packet.triggerPath === 'SWITCH_STATIC')).toHaveLength(0);
    expect(result.packets.length).toBeGreaterThanOrEqual(1); // 持续运动有 P 产出
    expect(result.telemetry.stopReason).toBe('end_of_window');
  });
});
