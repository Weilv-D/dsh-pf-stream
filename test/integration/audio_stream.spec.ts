/**
 * A7/A11/A12 集成：Epoch 冷区台词保留、probe 字幕导航、无音轨零侵入。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runStreamCallFixture } from './helpers.js';
import { handleToolCall, type ToolDeps } from '../../src/tool/handler.js';
import type { AsrSettings, AudioSettings } from '../../src/audio/types.js';
import type { ProbeResult } from '../../src/types.js';

let tmpRoot = '';

beforeAll(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'pf-audio-stream-'));
});

afterAll(async () => {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function audioSettings(cacheDir: string, asr: AsrSettings | null = null): AudioSettings {
  return {
    mode: 'auto',
    extractSubtitles: false,
    assistFocus: false,
    sliceCodec: 'mp3',
    cacheEnabled: true,
    cacheDir,
    graceMs: 8000,
    asr:
      asr ??
      {
        provider: 'openai_basic',
        baseUrl: 'http://asr.test/v1',
        apiKey: 'k',
        language: null,
        timeoutMs: 4000,
        maxConcurrency: 2,
      },
  };
}

describe('A12 无音轨零侵入', () => {
  it('case01_base 无音轨：音频开与关的输出逐字节一致（hintLines + 画布 SHA）', async () => {
    const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ text: '不应被请求' })),
    );
    const off = await runStreamCallFixture('case01_base.mp4', 'a12-off', { pts_window: [0, 1500] });
    const on = await runStreamCallFixture(
      'case01_base.mp4',
      'a12-on',
      { pts_window: [0, 1500] },
      { audio: { settings: audioSettings(path.join(tmpRoot, 'a12')), ffmpegPath: 'ffmpeg' } },
    );
    expect(on.audio.status).toBe('no_audio');
    expect(on.audioByPacket).toEqual({});
    expect(on.hintLines).toEqual(off.hintLines);
    const shas = (r: typeof off) => r.packets.map((a) => a.packet.anchorFSha256 ?? a.packet.stripSha256);
    expect(shas(on)).toEqual(shas(off));
    expect(on.telemetry.audioAssistFires).toBe(0);
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  }, 60_000);
});

describe('A7 Epoch 冷区台词保留', () => {
  it('冷区引用包的 audioSegments 与锚点 SHA 完整保留', async () => {
    const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ text: '岛台词内容' })),
    );
    const cacheDir = path.join(tmpRoot, 'a7');
    const audio = { settings: audioSettings(cacheDir), ffmpegPath: 'ffmpeg' };
    // 第一次调用用大 Epoch 窗口：全部新包原样输出（供后续按源包比对锚点 SHA）
    const first = await runStreamCallFixture(
      'case_audio_long.mp4',
      'a7',
      { pts_window: [0, 30_000], max_packets: 12 },
      { audio, epochCompactionWindow: 50 },
    );
    expect(first.packets.length).toBeGreaterThan(0);

    const second = await runStreamCallFixture(
      'case_audio_long.mp4',
      'a7',
      { pts_window: [30_000, 60_000], max_packets: 12 },
      { audio, epochCompactionWindow: 2 },
    );
    expect(second.coldRefCount).toBeGreaterThanOrEqual(1);

    // 冷区提示行带台词保留行
    const joined = second.hintLines.join('\n');
    expect(joined).toMatch(/\[Audio@#\d+\] \d+ segments retained/);

    // 冷区引用包在 audioByPacket 中带 segments（Epoch 收敛后台词仍保留在冷区链上）
    const coldWithAudio = second.packets.filter((a) => {
      const mount = second.audioByPacket[a.packet.packetId];
      return a.packet.historyMode === 'anchor_only_ref' && mount !== undefined && mount.segments.length > 0;
    });
    expect(coldWithAudio.length).toBeGreaterThanOrEqual(1);
    for (const artifact of coldWithAudio) {
      const mount = second.audioByPacket[artifact.packet.packetId]!;
      expect(mount.segments.length).toBeGreaterThan(0);
      for (const seg of mount.segments) {
        expect(seg.text.length).toBeGreaterThan(0);
      }
    }
    // 同参数重放（独立会话、共享缓存、同样两步调用）冷区锚点 SHA 集合一致：冷区引用字节可复现
    await runStreamCallFixture(
      'case_audio_long.mp4',
      'a7-replay',
      { pts_window: [0, 30_000], max_packets: 12 },
      { audio, epochCompactionWindow: 50 },
    );
    const replay = await runStreamCallFixture(
      'case_audio_long.mp4',
      'a7-replay',
      { pts_window: [30_000, 60_000], max_packets: 12 },
      { audio, epochCompactionWindow: 2 },
    );
    const shaSet = (r: typeof second) =>
      r.packets
        .filter((a) => a.packet.historyMode === 'anchor_only_ref')
        .map((a) => a.packet.anchorFSha256)
        .sort()
        .join('|');
    expect(shaSet(replay)).toBe(shaSet(second));
    // 新包也有台词挂载（岛台词覆盖 [0,10] 与 [20,30]）
    const newMounts = Object.entries(second.audioByPacket).filter(([pid]) => {
      const artifact = second.packets.find((a) => a.packet.packetId === Number(pid));
      return artifact?.packet.historyMode === 'initial';
    });
    expect(newMounts.length).toBeGreaterThanOrEqual(1);
  }, 120_000);
});

describe('A11 probe 字幕导航', () => {
  const fakeProbe: ProbeResult = {
    codedWidth: 320,
    codedHeight: 240,
    displayWidth: 320,
    displayHeight: 240,
    rotation: 0,
    durationMs: 3000,
    lastPtsMs: 2967,
    avgFps: 10,
    codec: 'h264',
    audioStreams: [{ index: 1, codec: 'aac', channels: 1 }],
    subtitleStreams: [
      { index: 2, codec: 'mov_text', language: 'chi' },
      { index: 3, codec: 'mov_text', language: 'eng' },
    ],
  };

  it('extractSubtitles 开：probe 结果带 subtitles 字段（source/language/segments）', async () => {
    const deps = {
      probe: async () => fakeProbe,
      audio: {
        resolveSettings: () =>
          ({ mode: 'auto', extractSubtitles: true, assistFocus: false, sliceCodec: 'mp3', cacheEnabled: false, cacheDir: tmpRoot, graceMs: 8000, asr: null }) as AudioSettings,
        subtitlesFor: async () => ({
          status: 'external_subtitle' as const,
          language: 'zh',
          segments: [
            { segId: 1, startMs: 400, endMs: 1200, text: '外挂第一句', source: 'external_subtitle' as const },
          ],
        }),
      },
    } as unknown as ToolDeps;
    const result = await handleToolCall(
      { video_path: 'x.mp4', intent: { action: 'probe' } },
      { signal: new AbortController().signal },
      deps,
    );
    expect(result.action).toBe('probe');
    expect(result.subtitles).toEqual({
      source: 'external_subtitle',
      language: 'zh',
      segments: [{ startMs: 400, endMs: 1200, text: '外挂第一句' }],
    });
  });

  it('无 audio deps：probe 不带 subtitles 字段', async () => {
    const deps = { probe: async () => fakeProbe } as unknown as ToolDeps;
    const result = await handleToolCall(
      { video_path: 'x.mp4', intent: { action: 'probe' } },
      { signal: new AbortController().signal },
      deps,
    );
    expect(result.action).toBe('probe');
    expect('subtitles' in result).toBe(false);
  });
});
