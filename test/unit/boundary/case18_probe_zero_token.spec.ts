/**
 * case 18 — probe 零视觉 Token（纯逻辑，注入桩 probe 通道，不依赖视频 fixture）。
 *
 * 断言：
 * 1. probe 出参字段集合与类型正确；
 * 2. 工具结果为纯 JSON 对象，不含图像内容块（视觉 Token = 0）。
 */

import { describe, expect, it } from 'vitest';
import { handleToolCall, type ProbeFn } from '../../../src/tool/handler.js';
import type { ProbeResult } from '../../../src/types.js';

const stubProbe: ProbeResult = {
  codedWidth: 640,
  codedHeight: 360,
  displayWidth: 640,
  displayHeight: 360,
  rotation: 0,
  durationMs: 3000,
  lastPtsMs: 2967,
  avgFps: 30,
  codec: 'h264',
  audioStreams: [{ index: 1, codec: 'aac', channels: 2 }],
  subtitleStreams: [{ index: 2, codec: 'mov_text', language: 'chi' }],
};

const stubProbeFn: ProbeFn = async () => stubProbe;

describe('case 18 — probe 零视觉 Token', () => {
  it('action 路由：intent.action="probe" 与顶层 probe_only 均进入 probe 通道', async () => {
    const byIntent = await handleToolCall({ video_path: 'x.mp4', intent: { action: 'probe' } }, undefined, {
      probe: stubProbeFn,
    });
    const byLegacy = await handleToolCall({ video_path: 'x.mp4', probe_only: true }, undefined, {
      probe: stubProbeFn,
    });
    expect(byIntent.action).toBe('probe');
    expect(byLegacy.action).toBe('probe');
  });

  it('probe 出参字段集合与类型齐全', async () => {
    const result = await handleToolCall({ video_path: 'x.mp4', intent: { action: 'probe' } }, undefined, {
      probe: stubProbeFn,
    });
    const probe = result.probe as ProbeResult;
    expect(typeof probe.displayWidth).toBe('number');
    expect(typeof probe.displayHeight).toBe('number');
    expect([0, 90, 180, 270]).toContain(probe.rotation);
    expect(typeof probe.lastPtsMs).toBe('number');
    expect(typeof probe.durationMs).toBe('number');
    expect(typeof probe.avgFps).toBe('number');
    expect(typeof probe.codec).toBe('string');
    expect(Array.isArray(probe.audioStreams)).toBe(true);
    expect(Array.isArray(probe.subtitleStreams)).toBe(true);
    expect(probe.audioStreams[0]).toEqual({ index: 1, codec: 'aac', channels: 2 });
    expect(probe.subtitleStreams[0]).toEqual({ index: 2, codec: 'mov_text', language: 'chi' });
  });

  it('工具结果为纯 JSON 文本承载，不含图像内容块（视觉 Token = 0）', async () => {
    const result = await handleToolCall({ video_path: 'x.mp4', intent: { action: 'probe' } }, undefined, {
      probe: stubProbeFn,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('image');
    expect(serialized).not.toContain('attachment');
    expect(serialized).not.toContain('base64');
    // 结果树中不出现字节/二进制载体字段
    expect(Object.keys(result).sort()).toEqual(['action', 'probe']);
  });
});
