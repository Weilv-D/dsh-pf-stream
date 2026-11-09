/**
 * 用例 25：SWITCH 硬切入纯黑场 ≥250ms + 渐显（P2-4 修复回归）。
 *
 * 修复前：观察窗到期（250ms）无条件清 fSwitchPending → switch_static_emit
 * 时 fSwitchImage 为 null 跳过且无兜底 → 整转场零图像包（规格案例9「纯黑场
 * ≥300ms 取 300ms 处兜底帧」不可达）。修复后：到期保留 pending，由顺延捕获
 * （黑场后首个正常曝光帧）或 300ms 兜底发射；兜底死线随游标快照跨窗口续接。
 *
 * fixture 结构：[0,0.95) testsrc2 内容 | [0.95,1.30) 纯黑 350ms | [1.30,2.40)
 * 黑场渐显 600ms → 白场静止。硬切点 ≈0.9667s，观察窗到期 ≈1.233s，300ms 兜底
 * ≈1.30~1.333s，兜底帧捕获后黑场渐显不再构成第二次硬切（掩盖路径已排除）。
 */
import { describe, expect, it } from 'vitest';
import { runStreamCallFixture } from './helpers.js';

function switchStaticPts(packets: Array<{ units: Array<{ eventType: string; timestampMs: number }> }>): number[] {
  return packets.flatMap((a) => a.packet.units)
    .filter((u) => u.eventType === 'SWITCH_STATIC')
    .map((u) => u.timestampMs);
}

describe('case25: SWITCH 纯黑场顺延与 300ms 兜底', () => {
  it('同窗：硬切入 350ms 纯黑 → 观察窗到期后由兜底分支发射黑帧', async () => {
    const result = await runStreamCallFixture(
      'case25_black_defer.mp4',
      'case25-same',
      {},
      { defaultStreamWindowMs: 4000 },
    );
    const pts = switchStaticPts(result.packets);
    expect(pts).toHaveLength(1);
    // 兜底捕获在 >0.95+0.3=1.25s 的首个帧（30fps 网格 ≈1.30~1.333s）
    expect(pts[0]).toBeGreaterThanOrEqual(1250);
    expect(pts[0]).toBeLessThanOrEqual(1700);
  }, 120_000);

  it('跨窗：切换点贴近窗口末，顺延在下一窗口完成（死线随快照续接）', async () => {
    const c1 = await runStreamCallFixture(
      'case25_black_defer.mp4',
      'case25-cross',
      {},
      { defaultStreamWindowMs: 1000 },
    );
    // 窗口 1 [0,1000)：SWITCH 已触发、死线已入快照，但到期与兜底都在窗 2
    expect(switchStaticPts(c1.packets)).toHaveLength(0);
    const c2 = await runStreamCallFixture(
      'case25_black_defer.mp4',
      'case25-cross',
      {},
      { defaultStreamWindowMs: 1000 },
    );
    const pts = switchStaticPts(c2.packets);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toBeGreaterThanOrEqual(1250);
    expect(pts[0]).toBeLessThanOrEqual(1700);
  }, 180_000);
});
