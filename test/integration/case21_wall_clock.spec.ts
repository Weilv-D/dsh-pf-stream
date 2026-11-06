/**
 * 用例 21：墙钟逃逸门（编排级）。
 *
 * 预算门只在出包点生效，超长窗口/低出包内容下解码会一路跑到客户端 900s 超时
 * （真机会话实测：全片窗 [70s,1657s] 900s 客户端超时）。墙钟门到点即停：
 * stopReason='wall_clock'，已消费窗口按游标正常续接，下次调用不重放。
 */

import { describe, expect, it } from 'vitest';
import { makeFixtureSlot, runFixtureStream } from './helpers.js';

const SESSION = 'case21-wall-clock';

describe('case21: 墙钟逃逸门（编排级）', () => {
  it('墙钟到点即停：stopReason=wall_clock，游标不越过已消费帧', async () => {
    const slot = await makeFixtureSlot('case14_slow.mp4');
    // 1ms 墙钟预算：decodeStart 覆盖 ffprobe pts 索引与 spawn，首帧回调必超限
    const result = await runFixtureStream('case14_slow.mp4', slot, { windowMs: 4000, wallClockBudgetMs: 1 });
    expect(result.telemetry.stopReason).toBe('wall_clock');
    expect(result.packets).toHaveLength(0);
    // 门在感知步进前生效：帧已解码但未消费
    expect(result.telemetry.framesStepped).toBe(0);
    // 无帧消费 → 游标停在窗口起点，下次调用原地重推
    expect(slot.cursor.lastConsumedPtsMs).toBe(0);
  }, 60_000);

  it('正常预算下墙钟门不误触发：推进完成且 stopReason 非 wall_clock', async () => {
    const slot = await makeFixtureSlot('case14_slow.mp4');
    const result = await runFixtureStream('case14_slow.mp4', slot, { windowMs: 4000 });
    expect(result.telemetry.stopReason).not.toBe('wall_clock');
    expect(result.packets.length).toBeGreaterThan(0);
  }, 120_000);
});
