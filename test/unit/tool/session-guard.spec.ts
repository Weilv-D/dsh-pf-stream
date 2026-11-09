/**
 * 会话状态守卫单元（P2-1 投递失败回滚 与 P2-2 字节截断清除）。
 *
 * P2-1：附件回传失败 → rollback 把会话内存态恢复到调用前（游标/序号/历史环
 * 全还原），下一调用重新消费同一窗口；期间有后续调用推进（mutationSeq 变化）
 * 则回滚跳过，避免抹掉后续调用状态。
 *
 * P2-2：precheck 字节水位截断的未投递增量包从历史环与 FUnitCache 摘除——
 * 保留在环中会让它们在下一轮收敛时被收编为冷区引用，违反「先投递后收编」
 * 不变式；同时给模型可行动提示行（此前只有 telemetry 可见）。
 */
import { describe, expect, it } from 'vitest';
import { handleToolCall } from '../../../src/tool/handler.js';
import { runStreamCall } from '../../../src/tool/streamCall.js';
import { fingerprintOf, getSessionState, peekSessionState } from '../../../src/session/state.js';
import { probeVideo } from '../../../src/stage0/probe.js';
import { fixturePath, streamCallOptions } from '../../integration/helpers.js';

const PATH = fixturePath('case14_slow.mp4');

async function probeOnce(): Promise<Awaited<ReturnType<typeof probeVideo>>> {
  return probeVideo(PATH, { ffprobePath: 'ffprobe' });
}

function toolDeps(
  probe: Awaited<ReturnType<typeof probeVideo>>,
  attach: (artifacts: unknown[]) => Promise<unknown[]>,
) {
  return {
    probe: async () => probe,
    stream: (vp: string, p: typeof probe, intent: unknown, sessionId: string | undefined, signal: AbortSignal | undefined) =>
      runStreamCall(vp, p, intent as never, sessionId ?? 'default', streamCallOptions({ defaultStreamWindowMs: 800 })),
    attachImages: attach,
    limits: { maxPackets: 20, maxTokensBudget: 65536, maxFrames: 128 },
  };
}

describe('P2-1 投递失败回滚', () => {
  it('附件回传失败 → 游标回滚到调用前，下一调用重新消费同一窗口', async () => {
    const probe = await probeOnce();
    const fp = fingerprintOf(PATH).sha256Short;
    // 回滚后槽位可能整体不存在（首访调用前的快照无 videos 槽位）＝游标 0
    const cursorBefore = () =>
      getSessionState('guard-rollback').videos.get(fp)?.cursor.lastConsumedPtsMs ?? 0;

    await expect(
      handleToolCall(
        { video_path: PATH } as never,
        { sessionId: 'guard-rollback' },
        toolDeps(probe, async () => {
          throw new Error('storage full');
        }),
      ),
    ).rejects.toThrow('storage full');

    // 回滚后游标回到 0；mutationSeq 由快照重建置 0
    expect(cursorBefore()).toBe(0);
    expect(getSessionState('guard-rollback').mutationSeq).toBe(0);

    // 第二次调用成功投递 → 正常推进
    const ok = await handleToolCall(
      { video_path: PATH } as never,
      { sessionId: 'guard-rollback' },
      toolDeps(probe, async (arts) => arts.map(() => ({ attachmentId: 'x' }))),
    );
    expect(cursorBefore()).toBeGreaterThan(0);
    expect((ok as { packets: unknown[] }).packets.length).toBeGreaterThanOrEqual(0);
  }, 180_000);

  it('期间有后续调用推进 → 回滚跳过（不抹掉后续状态）', async () => {
    const probe = await probeOnce();
    const fp = fingerprintOf(PATH).sha256Short;
    const sessionId = 'guard-race';

    const first = await runStreamCall(
      PATH, probe, {} as never, sessionId,
      streamCallOptions({ defaultStreamWindowMs: 800 }),
    );
    const cursorAfterFirst = first.nextCursor.lastConsumedPtsMs;
    // 模拟「失败调用的 rollback 被推迟到下一次调用之后」：第二次调用推进共享态
    const second = await runStreamCall(
      PATH, probe, {} as never, sessionId,
      streamCallOptions({ defaultStreamWindowMs: 800 }),
    );
    expect(second.nextCursor.lastConsumedPtsMs).toBeGreaterThan(cursorAfterFirst);

    expect(first.rollback()).toBe(false);
    const slot = getSessionState(sessionId).videos.get(fp);
    expect(slot?.cursor.lastConsumedPtsMs).toBe(second.nextCursor.lastConsumedPtsMs);
  }, 180_000);
});

describe('P2-2 字节水位截断清除', () => {
  it('maxRequestBytes=1 → 全部增量包截断，历史环清空 + 提示行', async () => {
    const probe = await probeOnce();
    const fp = fingerprintOf(PATH).sha256Short;
    const result = await runStreamCall(
      PATH,
      probe,
      {} as never,
      'guard-purge',
      streamCallOptions({ maxRequestBytes: 1 }),
    );
    expect(result.hintLines.join('\n')).toContain('字节水位截断');
    const slot = getSessionState('guard-purge').videos.get(fp);
    expect(slot?.history.packets).toHaveLength(0);
    // telemetry 如实保留丢弃记录
    expect(result.telemetry.precheck.dropped.some((d) => d.kind === 'new')).toBe(true);
  }, 180_000);

  it('截断只影响输出不影响环（无截断时环照常记录）', async () => {
    const probe = await probeOnce();
    const fp = fingerprintOf(PATH).sha256Short;
    const result = await runStreamCall(
      PATH,
      probe,
      {} as never,
      'guard-nopurge',
      streamCallOptions({ maxRequestBytes: 56 * 1024 * 1024 }),
    );
    if (result.packets.length > 0) {
      const slot = getSessionState('guard-nopurge').videos.get(fp);
      expect(slot?.history.packets.length).toBeGreaterThan(0);
    }
  }, 180_000);
});

describe('辅助不变式', () => {
  it('peekSessionState 对不存在会话返回 undefined（rollback 守卫依赖）', () => {
    expect(peekSessionState('no-such-session')).toBeUndefined();
  });
});
