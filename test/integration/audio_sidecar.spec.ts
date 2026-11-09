/**
 * A0/A2/A3/A8/A9 集成：音频侧车三级顺位、静音短路、verbose 降级、
 * 软截止后台补缓存、部分覆盖只补缺口。
 *
 * 网络 provider 用 vi.stubGlobal('fetch') 桩替代；真实 ffmpeg 仅用于
 * VAD 扫描与切片（fixture 均为 3 秒小文件）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAudioSidecar } from '../../src/audio/sidecar.js';
import { transcribeWindow } from '../../src/audio/asrRouter.js';
import { probeVideo } from '../../src/stage0/probe.js';
import { engineFingerprint, readTranscriptCache, videoFingerprint, writeTranscriptCache } from '../../src/audio/transcriptCache.js';
import type { AsrSettings, AudioSettings } from '../../src/audio/types.js';
import { fixturePath } from './helpers.js';

let tmpRoot = '';
let cacheA3 = '';
let cacheA8 = '';
let cacheA9 = '';

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'pf-audio-sidecar-'));
  cacheA3 = path.join(tmpRoot, 'a3');
  cacheA8 = path.join(tmpRoot, 'a8');
  cacheA9 = path.join(tmpRoot, 'a9');
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function asr(over: Partial<AsrSettings> = {}): AsrSettings {
  return {
    provider: 'openai_basic',
    baseUrl: 'http://asr.test/v1',
    apiKey: 'k',
    language: null,
    timeoutMs: 4000,
    maxConcurrency: 1,
    ...over,
  };
}

function settings(over: Partial<AudioSettings> & { asr?: AsrSettings | null } = {}): AudioSettings {
  const { asr: asrOver, ...rest } = over;
  const base: AudioSettings = {
    mode: 'auto',
    extractSubtitles: false,
    assistFocus: false,
    sliceCodec: 'mp3',
    cacheEnabled: true,
    cacheDir: cacheA8,
    graceMs: 8000,
    asr: asr(''),
  };
  return { ...base, ...rest, asr: asrOver === undefined ? base.asr : asrOver };
}

interface FetchCall {
  url: string;
  format: string | null;
}

function stubFetch(handler: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let format: string | null = null;
    const body = init?.body;
    if (body instanceof FormData) format = String(body.get('response_format') ?? '');
    const call = { url, format };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

const json = (doc: unknown, status = 200) => new Response(JSON.stringify(doc), { status });

describe('A0 字幕优先（内嵌软字幕）', () => {
  it('内嵌 chi 轨命中：status ok、source embedded_subtitle、切片到窗口', async () => {
    const video = fixturePath('case_audio_sub.mp4');
    const probe = await probeVideo(video, { ffprobePath: 'ffprobe' });
    const { fn } = stubFetch(() => {
      throw new Error('A0 不允许发起 ASR 请求');
    });
    const result = await runAudioSidecar(
      { videoPath: video, probe, ffmpegPath: 'ffmpeg', settings: settings({ extractSubtitles: true, asr: asr({ provider: 'openai_basic' }) }) },
      [0, 3000],
      Date.now() + 8000,
    );
    expect(result.context.status).toBe('ok');
    expect(result.context.source).toBe('embedded_subtitle');
    expect(result.context.language).toBe('chi');
    expect(result.segments.map((s) => s.text)).toEqual(['第一句字幕内容', '第二句字幕内容']);
    expect(fn).not.toHaveBeenCalled();
  }, 30_000);
});

describe('A1 静音短路', () => {
  it('尾窗 [1800,3000] 无语音岛：status silent，零 ASR 请求', async () => {
    const video = fixturePath('case_audio_silence.mp4');
    const probe = await probeVideo(video, { ffprobePath: 'ffprobe' });
    const { fn } = stubFetch(() => {
      throw new Error('静音短路不得发起 ASR 请求');
    });
    const result = await runAudioSidecar(
      { videoPath: video, probe, ffmpegPath: 'ffmpeg', settings: settings() },
      [1800, 3000],
      Date.now() + 8000,
    );
    expect(result.context.status).toBe('silent');
    expect(result.segments).toEqual([]);
    expect(result.context.telemetry.requests).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  }, 30_000);
});

describe('A3 verbose 400 → basic 降级', () => {
  it('verbose 被拒后整窗降级 basic：degradedToBasic、requests=2、段锚定到块区间', async () => {
    const video = fixturePath('case_audio_silence.mp4');
    const { calls } = stubFetch((call) => {
      if (call.format === 'verbose_json') return new Response('', { status: 400 });
      return json({ text: '岛内台词内容' });
    });
    const result = await transcribeWindow(video, [0, 3000], null, {
      ffmpegPath: 'ffmpeg',
      settings: asr({ provider: 'openai_verbose' }),
      cacheDir: cacheA3,
      cacheEnabled: true,
      sliceCodec: 'mp3',
    });
    expect(result.degradedToBasic).toBe(true);
    // requests 计块（1 块）；HTTP 调用两次：verbose 拒绝 + basic 重试
    expect(result.requests).toBe(1);
    expect(calls.map((c) => c.format)).toEqual(['verbose_json', 'json']);
    expect(result.segments.length).toBe(1);
    expect(result.segments[0]?.text).toBe('岛内台词内容');
    expect(result.segments[0]?.startMs).toBe(0);
    expect(result.segments[0]?.endMs).toBe(3000);
    expect(result.failedChunks).toBe(0);
  }, 30_000);
});

describe('A8 软截止先行返回 + 后台补缓存', () => {
  it('deadline 已过 → timeout_skipped；后台完成补缓存；二次调用零请求命中', async () => {
    const video = fixturePath('case_audio_silence.mp4');
    const probe = await probeVideo(video, { ffprobePath: 'ffprobe' });
    const { fn } = stubFetch(() => json({ text: '后台补齐的台词' }));
    const cfg = settings({ cacheDir: cacheA8 });

    const first = await runAudioSidecar(
      { videoPath: video, probe, ffmpegPath: 'ffmpeg', settings: cfg },
      [0, 3000],
      Date.now() - 1,
    );
    expect(first.context.status).toBe('timeout_skipped');
    expect(first.segments).toEqual([]);

    // 后台转写与缓存回写完成后，指纹缓存可见
    const fp = `${await videoFingerprint(video)}-${engineFingerprint(cfg.asr!)}`;
    await vi.waitFor(
      async () => {
        const cached = await readTranscriptCache(cacheA8, fp);
        expect(cached).not.toBeNull();
        expect(cached!.length).toBeGreaterThan(0);
      },
      { timeout: 20_000, interval: 200 },
    );

    const second = await runAudioSidecar(
      { videoPath: video, probe, ffmpegPath: 'ffmpeg', settings: cfg },
      [0, 3000],
      Date.now() + 8000,
    );
    expect(second.context.status).toBe('ok');
    // 0.4.4 缺口语义修正：后台按 VAD 岛切块落缓存，岛间静音区是真实缺口——
    // 第二次调用如实补转（旧语义 margin 外扩把缺口掩盖成假命中、永久成洞）。
    expect(second.context.telemetry.requests).toBeLessThanOrEqual(2);
    expect(second.context.telemetry.cacheHit).toBe(true);
    expect(second.segments.map((s) => s.text)).toContain('后台补齐的台词');
    // 第三次调用：缺口已补齐（缝合合并后全覆盖），零请求全命中
    const callsBeforeThird = fn.mock.calls.length;
    const third = await runAudioSidecar(
      { videoPath: video, probe, ffmpegPath: 'ffmpeg', settings: cfg },
      [0, 3000],
      Date.now() + 8000,
    );
    expect(third.context.status).toBe('ok');
    expect(third.context.telemetry.requests).toBe(0);
    expect(third.context.telemetry.cacheHit).toBe(true);
    expect(fn.mock.calls.length).toBe(callsBeforeThird);
  }, 60_000);
});

describe('A9 部分覆盖只补缺口', () => {
  it('缓存 [0,1000] + 窗口 [0,3000] → 仅补 [2000,3000]，缓存段与新段合并输出', async () => {
    const video = fixturePath('case_audio_silence.mp4');
    const probe = await probeVideo(video, { ffprobePath: 'ffprobe' });
    const { calls } = stubFetch(() => json({ text: '新补台词' }));
    const cfg = settings({ cacheDir: cacheA9 });
    const fp = `${await videoFingerprint(video)}-${engineFingerprint(cfg.asr!)}`;
    await writeTranscriptCache(cacheA9, fp, [
      {
        startMs: 0,
        endMs: 1000,
        source: 'asr',
        segments: [{ segId: 1, startMs: 600, endMs: 1000, text: '缓存台词', source: 'asr' }],
      },
    ]);

    const result = await runAudioSidecar(
      {
        videoPath: video,
        probe,
        ffmpegPath: 'ffmpeg',
        settings: settings({ cacheDir: cacheA9 }),
        // 预置 VAD：缺口 [2000,3000] 为语音岛（能量门放行；真实 fixture 该段静音）
        precomputedVad: { silence: [[0, 2000]], islands: [[2000, 3000]], rmsDb: -20, peakDb: -6, activeRatio: 1 / 3 },
      },
      [0, 3000],
      Date.now() + 8000,
    );
    expect(result.context.status).toBe('ok');
    expect(result.context.telemetry.requests).toBe(1);
    expect(result.context.telemetry.cacheHit).toBe(true);
    expect(calls.length).toBe(1);
    expect(result.segments.map((s) => s.text)).toEqual(['缓存台词', '新补台词']);
    // 新补段锚定到缺口区间 [2000,3000]
    expect(result.segments[1]?.startMs).toBeGreaterThanOrEqual(2000);
    expect(result.segments[1]?.endMs).toBeLessThanOrEqual(3000);
  }, 30_000);
});
