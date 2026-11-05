/** A1：字幕解析与选轨（外挂优先 / 内嵌 zh>en / 位图跳过 / 窗口切片）。 */
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findExternalSubtitle,
  loadSubtitleTimeline,
  parseAss,
  parseSrt,
  parseSubtitleFile,
  parseVtt,
  pickEmbeddedSubtitle,
  sliceSegments,
} from '../../../src/audio/subtitleExtractor.js';
import { probeVideo } from '../../../src/stage0/probe.js';
import type { ProbeResult } from '../../../src/types.js';
import { fixturePath } from '../../integration/helpers.js';

const SRT = '1\r\n00:00:01,000 --> 00:00:02,500\r\n你好世界\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nsecond line\r\n';

describe('A1 字幕解析', () => {
  it('parseSrt：CRLF 时间轴与重编号', () => {
    const segs = parseSrt(SRT, 'external_subtitle');
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ segId: 1, startMs: 1000, endMs: 2500, text: '你好世界', source: 'external_subtitle' });
    expect(segs[1]).toMatchObject({ segId: 2, startMs: 3000, endMs: 4000, text: 'second line' });
  });

  it('parseVtt：含 cue 设置行', () => {
    const segs = parseVtt('WEBVTT\n\n00:00:00.500 --> 00:00:01.000 align:start\nhello <b>vtt</b>\n', 'embedded_subtitle');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ startMs: 500, endMs: 1000, text: 'hello vtt' });
  });

  it('parseAss：Dialogue 行', () => {
    const segs = parseAss('[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:02.00,0:00:03.50,Default,,0,0,0,,ass 文本\n', 'embedded_subtitle');
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ startMs: 2000, endMs: 3500, text: 'ass 文本' });
  });

  it('parseSubtitleFile：按扩展名分派', () => {
    expect(parseSubtitleFile(SRT, 'srt', 'external_subtitle')).toHaveLength(2);
    expect(parseSubtitleFile('WEBVTT\n\n00:00:00.100 --> 00:00:00.200\nx\n', 'vtt', 'external_subtitle')).toHaveLength(1);
  });

  it('pickEmbeddedSubtitle：zh 优先、位图跳过、无文本轨为 null', () => {
    const mk = (streams: Array<{ codec: string; language?: string }>): ProbeResult => ({
      codedWidth: 0, codedHeight: 0, displayWidth: 0, displayHeight: 0,
      rotation: 0, durationMs: 0, lastPtsMs: 0, avgFps: 0, codec: 'h264',
      audioStreams: [],
      subtitleStreams: streams.map((s, i) => ({ index: i, codec: s.codec, language: s.language })),
    });
    expect(pickEmbeddedSubtitle(mk([
      { codec: 'hdmv_pgs_subtitle' }, { codec: 'mov_text', language: 'eng' }, { codec: 'subrip', language: 'chi' },
    ]))).toEqual({ ordinal: 2, language: 'chi' });
    expect(pickEmbeddedSubtitle(mk([{ codec: 'hdmv_pgs_subtitle' }]))).toBeNull();
    expect(pickEmbeddedSubtitle(mk([]))).toBeNull();
  });

  it('sliceSegments：按窗口裁剪', () => {
    const segs = parseSrt(SRT, 'external_subtitle');
    expect(sliceSegments(segs, [0, 1200])).toHaveLength(1);
    expect(sliceSegments(segs, [5000, 6000])).toHaveLength(0);
  });
});

describe('A1 外挂字幕定位与优先级', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'pf-sub-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('findExternalSubtitle：zh 优先于 en', async () => {
    mkdirSync(join(dir, 'a'), { recursive: true });
    const video = join(dir, 'a', 'v.mp4');
    writeFileSync(video, 'x');
    expect(await findExternalSubtitle(video)).toBeNull();
    writeFileSync(join(dir, 'a', 'v.en.srt'), SRT);
    expect(await findExternalSubtitle(video)).toBe(join(dir, 'a', 'v.en.srt'));
    writeFileSync(join(dir, 'a', 'v.zh.srt'), SRT);
    expect(await findExternalSubtitle(video)).toBe(join(dir, 'a', 'v.zh.srt'));
  });

  it('loadSubtitleTimeline：内嵌 zh 轨（无外挂）', async () => {
    const video = fixturePath('case_audio_sub.mp4');
    const timeline = await loadSubtitleTimeline(video, await probeVideo(video, { ffprobePath: 'ffprobe' }), { ffmpegPath: 'ffmpeg' });
    expect(timeline.status).toBe('embedded_subtitle');
    expect(timeline.language).toBe('chi');
    expect(timeline.segments.map((s) => s.text)).toEqual(['第一句字幕内容', '第二句字幕内容']);
    expect(timeline.segments[0]).toMatchObject({ startMs: 400, endMs: 1200 });
  });

  it('loadSubtitleTimeline：外挂优先于内嵌', async () => {
    cpSync(fixturePath('case_audio_sub.mp4'), join(dir, 'case_audio_sub.mp4'));
    writeFileSync(join(dir, 'case_audio_sub.srt'), '1\n00:00:00,100 --> 00:00:00,900\n外挂字幕\n', 'utf8');
    const video = join(dir, 'case_audio_sub.mp4');
    const timeline = await loadSubtitleTimeline(video, await probeVideo(video, { ffprobePath: 'ffprobe' }), { ffmpegPath: 'ffmpeg' });
    expect(timeline.status).toBe('external_subtitle');
    expect(timeline.segments).toHaveLength(1);
    expect(timeline.segments[0]?.text).toBe('外挂字幕');
  });
});
