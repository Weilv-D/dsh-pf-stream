/**
 * Stage A0 —— 字幕提取（外挂同名文件优先，内嵌软字幕次之）。
 *
 * 外挂：与视频同目录、同主文件名，扩展名 srt / vtt / ass / ssa，
 * 允许中间语言段（base.zh.srt）；语言优先级 zh > en > 其他。
 * 内嵌：probe.subtitleStreams 中的文本字幕轨（排除位图轨），
 * ffmpeg -map 0:s:N -f webvtt - 转出后统一按 VTT 解析。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from '../stage0/ffmpeg.js';
import type { ProbeResult } from '../types.js';
import type { AudioSourceKind, SubtitleTimeline, TranscriptSegment } from './types.js';

const SUBTITLE_EXTS = new Set(['srt', 'vtt', 'ass', 'ssa']);

/** ffprobe codec_name 中的文本字幕轨（其余为位图，跳过）。 */
const TEXT_SUBTITLE_CODECS = new Set([
  'subrip',
  'srt',
  'ass',
  'ssa',
  'webvtt',
  'mov_text',
  'text',
]);

interface CandidateFile {
  file: string;
  langRank: number;
  index: number;
}

function languageRank(lang: string | undefined): number {
  const l = (lang ?? '').toLowerCase();
  if (/^(zh|chi|zho|chs|cht)/.test(l)) return 0;
  if (/^(en|eng)/.test(l)) return 1;
  return 2;
}

/** 同目录外挂字幕候选扫描。 */
export async function findExternalSubtitle(videoPath: string): Promise<string | null> {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const candidates: CandidateFile[] = [];
  for (const entry of entries) {
    const m = new RegExp(`^${escapeRegExp(base)}(?:\\.([\\w-]+))?\\.(srt|vtt|ass|ssa)$`, 'i').exec(entry);
    if (!m) continue;
    const ext = (m[2] ?? '').toLowerCase();
    if (!SUBTITLE_EXTS.has(ext)) continue;
    candidates.push({
      file: path.join(dir, entry),
      langRank: m[1] ? languageRank(m[1]) : 2,
      index: candidates.length,
    });
  }
  const first = candidates[0];
  if (first === undefined) return null;
  candidates.sort((a, b) => a.langRank - b.langRank || a.index - b.index);
  return candidates[0] === undefined ? null : candidates[0].file;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 内嵌文本字幕轨选择（zh > en > 首轨；返回轨序号，不是流 index）。 */
export function pickEmbeddedSubtitle(probe: ProbeResult): { ordinal: number; language: string | null } | null {
  const textTracks = probe.subtitleStreams
    .map((s, i) => ({ ...s, ordinal: i }))
    .filter((s) => TEXT_SUBTITLE_CODECS.has(s.codec.toLowerCase()));
  if (textTracks.length === 0) return null;
  textTracks.sort((a, b) => languageRank(a.language) - languageRank(b.language) || a.ordinal - b.ordinal);
  const best = textTracks[0];
  return best === undefined ? null : { ordinal: best.ordinal, language: best.language ?? null };
}

/** 提取内嵌软字幕：转 webvtt 文本（PTS 毫秒由解析器恢复）。 */
export async function extractEmbeddedSubtitle(
  videoPath: string,
  ordinal: number,
  ffmpegPath: string,
  signal?: AbortSignal | undefined,
): Promise<string> {
  const { stdout } = await execFile(
    ffmpegPath,
    ['-nostdin', '-i', videoPath, '-map', `0:s:${ordinal}`, '-f', 'webvtt', '-'],
    { encoding: 'utf8', timeoutMs: 60_000, signal },
  );
  return stdout;
}

function parseTimeToMs(text: string): number | null {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(text);
  if (!m) return null;
  const h = m[1] ? Number(m[1]) : 0;
  return (
    ((h * 60 + Number(m[2] ?? '0')) * 60 + Number(m[3] ?? '0')) * 1000 +
    Number((m[4] ?? '0').padEnd(3, '0'))
  );
}

/** SRT 解析。 */
export function parseSrt(content: string, source: AudioSourceKind): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const blocks = content.replace(/\r\n/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [a, b] = timeLine.split('-->');
    const start = parseTimeToMs(a ?? '');
    const end = parseTimeToMs(b ?? '');
    if (start === null || end === null || end <= start) continue;
    const textLines = lines.filter((l) => l !== timeLine && !/^\d+$/.test(l.trim()));
    const text = textLines.join(' ').trim();
    if (!text) continue;
    out.push({ segId: out.length + 1, startMs: start, endMs: end, text, source });
  }
  return renumber(out);
}

/** WebVTT 解析（含 ffmpeg 转出的 mov_text 副本）。 */
export function parseVtt(content: string, source: AudioSourceKind): TranscriptSegment[] {
  const body = content.replace(/\r\n/g, '\n');
  const out: TranscriptSegment[] = [];
  const cueRe = /((?:\d+:)?\d{1,2}:\d{1,2}\.\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}\.\d{1,3})[^\n]*\n([\s\S]*?)(?=\n{2,}|$)/g;
  let m: RegExpExecArray | null;
  while ((m = cueRe.exec(body)) !== null) {
    const start = parseTimeToMs(m[1] ?? '');
    const end = parseTimeToMs(m[2] ?? '');
    if (start === null || end === null || end <= start) continue;
    const text = (m[3] ?? '')
      .split('\n')
      .map(stripVttMarkup)
      .join(' ')
      .trim();
    if (!text) continue;
    out.push({ segId: out.length + 1, startMs: start, endMs: end, text, source });
  }
  return renumber(out);
}

function stripVttMarkup(line: string): string {
  return line.replace(/<[^>]+>/g, '').trim();
}

/** ASS/SSA 解析（Dialogue 行，第 10 列起为文本）。 */
export function parseAss(content: string, source: AudioSourceKind): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith('Dialogue:')) continue;
    const cells = line.slice('Dialogue:'.length).split(',');
    if (cells.length < 10) continue;
    const start = parseAssClock(cells[1] ?? '');
    const end = parseAssClock(cells[2] ?? '');
    if (start === null || end === null || end <= start) continue;
    const text = cells
      .slice(9)
      .join(',')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N|\\n/g, ' ')
      .trim();
    if (!text) continue;
    out.push({ segId: out.length + 1, startMs: start, endMs: end, text, source });
  }
  return renumber(out);
}

function parseAssClock(text: string): number | null {
  const m = /(\d+):(\d{1,2}):(\d{1,2})\.(\d{1,2})/.exec(text);
  if (!m) return null;
  return (
    (Number(m[1] ?? '0') * 3600 + Number(m[2] ?? '0') * 60 + Number(m[3] ?? '0')) * 1000 +
    Number((m[4] ?? '0').padEnd(3, '0'))
  );
}

function renumber(segs: TranscriptSegment[]): TranscriptSegment[] {
  return segs.map((s, i) => ({ ...s, segId: i + 1 }));
}

/** 按扩展名分派解析。 */
export function parseSubtitleFile(content: string, ext: string, source: AudioSourceKind): TranscriptSegment[] {
  switch (ext.toLowerCase()) {
    case 'srt':
      return parseSrt(content, source);
    case 'vtt':
      return parseVtt(content, source);
    case 'ass':
    case 'ssa':
      return parseAss(content, source);
    default:
      return [];
  }
}

function languageOfExternal(file: string): string | null {
  const m = /\.([\w-]+)\.(srt|vtt|ass|ssa)$/i.exec(file);
  return m !== null ? (m[1] ?? null) : null;
}

/**
 * A0 主入口：外挂 → 内嵌 → none。抛错由调用方转软降级状态。
 */
export async function loadSubtitleTimeline(
  videoPath: string,
  probe: ProbeResult,
  deps: { ffmpegPath: string; signal?: AbortSignal | undefined },
): Promise<SubtitleTimeline> {
  const external = await findExternalSubtitle(videoPath);
  if (external) {
    const content = await readFile(external, 'utf8');
    const segments = parseSubtitleFile(content, path.extname(external).slice(1), 'external_subtitle');
    if (segments.length > 0) {
      return { status: 'external_subtitle', language: languageOfExternal(external), segments };
    }
  }
  const embedded = pickEmbeddedSubtitle(probe);
  if (embedded) {
    const vtt = await extractEmbeddedSubtitle(videoPath, embedded.ordinal, deps.ffmpegPath, deps.signal);
    const segments = parseVtt(vtt, 'embedded_subtitle');
    if (segments.length > 0) {
      return { status: 'embedded_subtitle', language: embedded.language, segments };
    }
  }
  return { status: 'none', language: null, segments: [] };
}

/** 窗口内的字幕段（闭区间相交即取）。 */
export function sliceSegments(segments: TranscriptSegment[], window: [number, number]): TranscriptSegment[] {
  return segments.filter((s) => s.endMs > window[0] && s.startMs < window[1]);
}
