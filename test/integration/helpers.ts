/**
 * 流式集成测试共用：探测 + 构造会话槽位 + 单次流式窗口推进。
 */

import { join } from 'node:path';
import { expect } from 'vitest';
import { probeVideo } from '../../src/stage0/probe.js';
import { runStreamPass, type StreamRunOptions, type StreamRunResult } from '../../src/stage3/streamSampler.js';
import { createSessionState, getVideoSlot, fingerprintOf } from '../../src/session/state.js';
import type { SessionIntent, SessionVideoState } from '../../src/types.js';

export const FIXTURES = join(process.cwd(), 'test', 'fixtures', 'media');

export function fixturePath(name: string): string {
  return join(FIXTURES, name);
}

export async function makeSlot(path: string): Promise<SessionVideoState> {
  const state = createSessionState('test-session');
  return getVideoSlot(state, fingerprintOf(path));
}

/** 以 fixture 文件名构造会话槽位（常用路径）。 */
export async function makeFixtureSlot(name: string): Promise<SessionVideoState> {
  return makeSlot(fixturePath(name));
}

export const STANDARD_INTENT: SessionIntent = {
  intentId: 'intent_1',
  mode: 'standard',
  focus: 'balanced',
  fullFrame: false,
};

export function streamOptions(over: Partial<StreamRunOptions> = {}): StreamRunOptions {
  return {
    ffmpegPath: 'ffmpeg',
    renderVisualId: false,
    windowMs: 4000,
    windowStartMs: 0,
    streamWorkMaxEdge: 0,
    maxPackets: 64,
    maxTokensBudget: 65536,
    appliedIntentId: 'intent_1',
    packetIdStart: 1,
    globalIdStart: 1,
    heartbeatSeqStart: 1,
    ...over,
  };
}

export async function runFixtureStream(
  name: string,
  slot: SessionVideoState,
  options: Partial<StreamRunOptions> = {},
): Promise<StreamRunResult> {
  const path = fixturePath(name);
  const probe = await probeVideo(path, { ffprobePath: 'ffprobe' });
  return runStreamPass(path, probe, STANDARD_INTENT, slot.cursor, streamOptions(options));
}

/** 画布合法性：42px 整除、计费 ≤1024、bbox 对齐（契约 1）。 */
export function expectPacketLegal(result: StreamRunResult): void {
  for (const { packet } of result.packets) {
    const [w, h] = packet.canvasSize;
    expect(w % 42).toBe(0);
    expect(h % 42).toBe(0);
    const tokens = (h / 42) * (w / 42 + 1) + 2;
    expect(tokens).toBeLessThanOrEqual(1024);
    for (const u of packet.units) {
      const [x0, y0, x1, y1] = u.contentPixelBbox;
      expect(x0 % 42).toBe(0);
      expect(y0 % 42).toBe(0);
      expect(x1 % 42).toBe(0);
      expect(y1 % 42).toBe(0);
      expect(x1 - x0).toBeGreaterThan(0);
      expect(y1 - y0).toBeGreaterThanOrEqual(84);
    }
  }
}
