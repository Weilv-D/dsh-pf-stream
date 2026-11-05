/**
 * ASR 幻觉清洗（四重，按序执行）。
 *
 * 1. 能量前置：完全落在 VAD 静音区（±100ms 余量）的段剔除；
 * 2. 置信度门控：no_speech_prob>0.65 且 avg_logprob<-0.8，或 compression_ratio>2.4 剔除；
 * 3. n-gram 复读折叠：单字/单词连续 ≥3 次折叠为一次，整段复读剔除；
 * 4. 黑名单：字幕组/平台水印仅在「静音区命中」或「短独立句」时精准拦截。
 */

import type { TranscriptSegment, VadResult } from './types.js';

export interface GuardResult {
  segments: TranscriptSegment[];
  dropped: number;
}

const CONF_NO_SPEECH = 0.65;
const CONF_LOGPROB = -0.8;
const CONF_COMPRESSION = 2.4;

const BLOCKLIST = [
  '字幕由',
  '字幕制作',
  'amara.org',
  'amara',
  '请不吝点赞',
  '订阅频道',
  '关注订阅',
  'thank you for watching',
  'thanks for watching',
  '仅供学习',
  '供学习交流',
  'benefitted from',
];

/** 相对静音判定：段与任一静音区重叠比例 ≥80%。 */
function inSilence(seg: TranscriptSegment, silence: Array<[number, number]>): boolean {
  if (silence.length === 0) return false;
  for (const [a, b] of silence) {
    const s = Math.max(seg.startMs, a - 100);
    const e = Math.min(seg.endMs, b + 100);
    if (e > s && e - s >= 0.8 * (seg.endMs - seg.startMs)) return true;
  }
  return false;
}

function confidenceFail(seg: TranscriptSegment): boolean {
  if (seg.noSpeechProb !== undefined && seg.avgLogprob !== undefined) {
    if (seg.noSpeechProb > CONF_NO_SPEECH && seg.avgLogprob < CONF_LOGPROB) return true;
  }
  if (seg.compressionRatio !== undefined && seg.compressionRatio > CONF_COMPRESSION) return true;
  return false;
}

/** 单字符（CJK）与拉丁词的连续复读折叠。 */
export function foldRepeats(text: string): string | null {
  const cjk = text.replace(/([\u4e00-\u9fff])\1{2,}/g, '$1');
  const latin = cjk.replace(/\b(\w+)(\s+\1\b){2,}/gi, '$1');
  // 折叠后空文本 → 整段复读
  if (latin.replace(/[\s,.\u3002\uff0c!?！？]/g, '').length === 0) return null;
  return latin;
}

function blocklistHit(seg: TranscriptSegment, silence: Array<[number, number]>): boolean {
  const hit = BLOCKLIST.find((w) => seg.text.toLowerCase().includes(w));
  if (!hit) return false;
  return inSilence(seg, silence) || seg.text.length <= 40;
}

export function guardSegments(
  segments: TranscriptSegment[],
  vad: VadResult | null,
): GuardResult {
  const silence = vad?.silence ?? [];
  const kept: TranscriptSegment[] = [];
  let dropped = 0;
  for (const seg of segments) {
    if (inSilence(seg, silence)) {
      dropped++;
      continue;
    }
    if (confidenceFail(seg)) {
      dropped++;
      continue;
    }
    const folded = foldRepeats(seg.text);
    if (folded === null) {
      dropped++;
      continue;
    }
    const candidate: TranscriptSegment = { ...seg, text: folded };
    if (blocklistHit(candidate, silence)) {
      dropped++;
      continue;
    }
    kept.push(candidate);
  }
  return { segments: kept, dropped };
}

/** 语速（字符/秒）：去空白字符数 ÷ 语音岛总时长。 */
export function speechRateCps(segments: TranscriptSegment[], vad: VadResult | null): number | null {
  const speechMs = vad ? vad.islands.reduce((acc, [a, b]) => acc + (b - a), 0) : 0;
  if (speechMs <= 0 || segments.length === 0) return null;
  const chars = segments.reduce((acc, s) => acc + s.text.replace(/\s/g, '').length, 0);
  return chars / (speechMs / 1000);
}
