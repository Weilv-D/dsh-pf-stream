/**
 * 入口适配层单元测试：历史便捷字段归一化、枚举校验、钳制、
 * 会话意图合并（reset 语义）与宿主会话标识解析。
 */

import { describe, expect, it } from 'vitest';
import { adaptCallArgs } from '../../../src/entry/adapter.js';
import { normalizeLegacyArgs, toMs } from '../../../src/entry/legacyNormalizer.js';
import { mergeSessionIntent, sessionIntentChanged } from '../../../src/stage5/intent.js';
import { resolveSessionId, type ToolExec } from '../../../src/tool/handler.js';
import { resolveTargets } from '../../../src/stage3/deterministicRouter.js';
import { fingerprintOf } from '../../../src/session/state.js';
import { PfStreamError } from '../../../src/errors.js';
import type { ProbeResult } from '../../../src/types.js';

const PROBE: ProbeResult = {
  codedWidth: 640,
  codedHeight: 360,
  displayWidth: 640,
  displayHeight: 360,
  rotation: 0,
  durationMs: 4000,
  lastPtsMs: 3966.67,
  avgFps: 30,
  codec: 'h264',
  audioStreams: [],
  subtitleStreams: [],
};

const LIMITS = {
  lastPtsMs: PROBE.lastPtsMs,
  displayWidth: PROBE.displayWidth,
  displayHeight: PROBE.displayHeight,
  maxPackets: 64,
  maxTokensBudget: 65536,
};

describe('toMs 判秒规则（≤2×时长判秒）', () => {
  it('时长 4s：数值 ≤8 判秒，>8 判毫秒', () => {
    expect(toMs(2, 4000)).toBe(2000);
    expect(toMs(8, 4000)).toBe(8000);
    expect(toMs(8.5, 4000)).toBe(9);
    expect(toMs(1500, 4000)).toBe(1500);
  });
});

describe('normalizeLegacyArgs：像素坐标 ROI 按显示宽高换算', () => {
  it('crop 全部分量 >1 → 像素模式', () => {
    const { intent } = normalizeLegacyArgs(
      { crop: { x: 160, y: 90, w: 320, h: 180 } },
      PROBE.durationMs,
      { width: 640, height: 360 },
    );
    expect(intent.roi_hint).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  });
  it('归一化坐标（分量 ≤1）原样钳制', () => {
    const { intent } = normalizeLegacyArgs(
      { roi: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
      PROBE.durationMs,
      { width: 640, height: 360 },
    );
    expect(intent.roi_hint).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
  });
});

describe('adaptCallArgs：归一化 + 校验 + 钳制', () => {
  it('顶层 start_time/end_time（秒）→ pts_window（毫秒，钳制 last_pts_ms）', () => {
    const { intent } = adaptCallArgs(
      { video_path: 'v.mp4', start_time: 1, end_time: 5000 },
      LIMITS,
    );
    expect(intent.pts_window).toEqual([1000, 3966.67]);
  });
  it('probe_only → action=probe', () => {
    const { intent } = adaptCallArgs({ video_path: 'v.mp4', probe_only: true }, LIMITS);
    expect(intent.action).toBe('probe');
  });
  it('action 枚举外值拒绝', () => {
    expect(() =>
      adaptCallArgs({ video_path: 'v.mp4', intent: { action: 'stream' } }, LIMITS),
    ).toThrowError(PfStreamError);
  });
  it('max_packets 超上限钳制到 limits.maxPackets', () => {
    const { intent } = adaptCallArgs(
      { video_path: 'v.mp4', intent: { max_packets: 999 } },
      LIMITS,
    );
    expect(intent.max_packets).toBe(64);
  });
  it('pts_window 越界钳制并保持升序', () => {
    const { intent } = adaptCallArgs(
      { video_path: 'v.mp4', intent: { pts_window: [5000, -10] } },
      LIMITS,
    );
    expect(intent.pts_window).toEqual([0, 3966.67]);
  });
});

describe('mergeSessionIntent：reset 语义', () => {
  const prev = { intentId: 'intent_2', mode: 'standard' as const, focus: 'balanced' as const, fullFrame: false };
  it('reset:true 与新字段同调用时新字段生效（不被默认值覆盖）', () => {
    const merged = mergeSessionIntent(prev, { reset: true, mode: 'dense' }, {
      mode: 'standard',
      focus: 'balanced',
    });
    expect(merged.mode).toBe('dense');
    expect(merged.focus).toBe('balanced');
  });
  it('reset:true 清空 roi_hint 与 full_frame', () => {
    const withRoi = { ...prev, roiHint: { x: 0, y: 0, w: 1, h: 1 }, fullFrame: true };
    const merged = mergeSessionIntent(withRoi, { reset: true }, { mode: 'standard', focus: 'balanced' });
    expect(merged.roiHint).toBeUndefined();
    expect(merged.fullFrame).toBe(false);
  });
  it('sessionIntentChanged 检测字段级差异', () => {
    expect(sessionIntentChanged(prev, { ...prev })).toBe(false);
    expect(sessionIntentChanged(prev, { ...prev, mode: 'sparse' })).toBe(true);
    expect(sessionIntentChanged(prev, { ...prev, roiHint: { x: 0, y: 0, w: 0.5, h: 0.5 } })).toBe(true);
  });
});

describe('resolveSessionId：宿主会话标识解析', () => {
  it('顶层 sessionId 优先', () => {
    const exec = { sessionId: 'a', agent: { session: { id: 'b' } } } as unknown as ToolExec;
    expect(resolveSessionId(exec)).toBe('a');
  });
  it('缺顶层时取 agent.session.id（dsh-tools exec 语义）', () => {
    const exec = { agent: { session: { id: 'sess-9' } } } as unknown as ToolExec;
    expect(resolveSessionId(exec)).toBe('sess-9');
  });
  it('均缺省返回 undefined（入口聚合 default 会话）', () => {
    expect(resolveSessionId(undefined)).toBeUndefined();
    expect(resolveSessionId({ signal: new AbortController().signal })).toBeUndefined();
  });
});

describe('resolveTargets：uniform 缺 interval 与 frame_count 时显式报错', () => {
  it('抛 PFSTREAM_UNIFORM_PARAMS_MISSING', () => {
    expect(() => resolveTargets({ action: 'uniform' }, PROBE)).toThrowError(PfStreamError);
    try {
      resolveTargets({ action: 'uniform' }, PROBE);
    } catch (e) {
      expect((e as PfStreamError).code).toBe('PFSTREAM_UNIFORM_PARAMS_MISSING');
    }
  });
});

describe('fingerprintOf：路径大小写（Windows 不敏感文件系统）', () => {
  it.skipIf(process.platform !== 'win32')('大小写变体产生相同指纹', () => {
    const base = process.cwd().replaceAll('\\', '/');
    const p = `${base}/test/fixtures/media/case01_base.mp4`;
    const mixed = p
      .split('/')
      .map((seg, i) => (i === 0 || seg.length === 0 ? seg : seg.charAt(0).toUpperCase() + seg.slice(1)))
      .join('/');
    const a = fingerprintOf(p);
    const b = fingerprintOf(mixed);
    expect(a.sha256Short).toBe(b.sha256Short);
    expect(a.sizeBytes).toBe(b.sizeBytes);
  });
});
