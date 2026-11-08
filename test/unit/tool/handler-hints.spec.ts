/**
 * pf_stream 停止提示行与落盘时序单元：budget_packets 提示（P2-5）与
 * 「投递成功后才 commit」时序（P2-7）的回归防线。
 */

import { describe, expect, it } from 'vitest';
import { handleToolCall, type ToolDeps } from '../../../src/tool/handler.js';
import type { StreamCallResult } from '../../../src/tool/streamCall.js';

/** 最小可用 probe 结果（handler 只用 lastPtsMs 与 adapter 所需字段）。 */
const probeStub = {
  lastPtsMs: 60_000,
  audioStreams: [],
  videoStreamIndex: 0,
  displayWidth: 1344,
  displayHeight: 672,
} as never;

function fakeStreamResult(
  stopReason: 'budget_packets' | 'budget_tokens' | 'wall_clock' | 'end_of_window' | 'end_of_stream',
  commitCalls: number[],
): StreamCallResult {
  return {
    packets: [],
    hintLines: [],
    heartbeats: [],
    telemetry: {
      decodeMs: 0,
      perceiveMs: 0,
      packMs: 0,
      pathLatencyMs: 0,
      framesDecoded: 0,
      framesStepped: 0,
      ptsRealign: 0,
      ffmpegSpawns: [],
      arenaMaxHeld: 0,
      window: [0, 0],
      stopReason,
      ctrlParams: {},
      ctrlTickLog: [],
      audioAssistFires: 0,
    },
    nextCursor: { lastConsumedPtsMs: 0 },
    counters: { packetSeq: 0, globalUnitSeq: 0, heartbeatSeq: 0 },
    coldRefCount: 0,
    hotRefCount: 0,
    sessionIntentId: 'intent_1',
    appliedIntentId: 'unit-test',
    audio: { status: 'no_audio', source: null, language: null, speechRatio: null, rmsDb: null, speechRateCps: null, segmentsInWindow: 0, mountedPackets: 0, telemetry: { cacheHit: false, chunks: 0, requests: 0, droppedByGuard: 0, costMs: 0 } },
    audioByPacket: {},
    commit: async () => {
      commitCalls.push(1);
      return true;
    },
  } as unknown as StreamCallResult;
}

function depsWith(stream: () => Promise<StreamCallResult>, attach?: ToolDeps['attachImages']): ToolDeps {
  return {
    probe: async () => probeStub,
    stream,
    attachImages: attach,
    limits: { maxPackets: 20, maxTokensBudget: 65536, maxFrames: 128 },
  };
}

describe('pf_stream 停止提示行（handler）', () => {
  it('budget_packets 停止时补可行动提示行（与确定性通道同语义）', async () => {
    const commits: number[] = [];
    const result = await handleToolCall(
      { video_path: 'v.mp4' } as never,
      undefined,
      depsWith(async () => fakeStreamResult('budget_packets', commits)),
    );
    expect(result.hintLines.some((l) => l.includes('已达单次调用包数上限'))).toBe(true);
  });

  it('end_of_stream 不补停止提示行', async () => {
    const result = await handleToolCall(
      { video_path: 'v.mp4' } as never,
      undefined,
      depsWith(async () => fakeStreamResult('end_of_stream', [])),
    );
    expect(result.hintLines.some((l) => l.includes('已达'))).toBe(false);
  });
});

describe('落盘时序（P2-7）', () => {
  it('附件回传成功后才调用 commit', async () => {
    const events: string[] = [];
    const commits: number[] = [];
    const attach = async (arts: unknown[]): Promise<never[]> => {
      events.push('attach');
      return [];
    };
    const result = await handleToolCall(
      { video_path: 'v.mp4' } as never,
      undefined,
      depsWith(async () => fakeStreamResult('end_of_window', commits), attach as never),
    );
    await Promise.resolve();
    expect(events).toEqual(['attach']);
    expect(commits).toEqual([1]);
    expect(result.packets).toEqual([]);
  });

  it('附件回传抛错时 commit 不被调用（失败路径不落盘）', async () => {
    const commits: number[] = [];
    const attach = async (): Promise<never[]> => {
      throw new Error('disk full');
    };
    await expect(
      handleToolCall(
        { video_path: 'v.mp4' } as never,
        undefined,
        depsWith(async () => fakeStreamResult('end_of_window', commits), attach as never),
      ),
    ).rejects.toThrow('disk full');
    expect(commits).toEqual([]);
  });
});
