/** A4：幻觉清洗（静音截断 / 置信度 / 复读折叠 / 黑名单 / emoji 清洗）。 */
import { describe, expect, it } from 'vitest';
import { foldRepeats, guardSegments, speechRateCps, stripEmoji } from '../../../src/audio/hallucinationGuard.js';
import type { TranscriptSegment, VadResult } from '../../../src/audio/types.js';

const seg = (id: number, startMs: number, endMs: number, text: string, extra: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  segId: id, startMs, endMs, text, source: 'asr', ...extra,
});

const vadOf = (silence: Array<[number, number]>, islands: Array<[number, number]> = []): VadResult => ({
  silence, islands, rmsDb: -20, peakDb: -6, activeRatio: 0.3,
});

describe('A4 幻觉清洗', () => {
  it('静音区内（≥80% 重叠）截断', () => {
    const r = guardSegments([seg(1, 0, 2000, '静音中的幻觉')], vadOf([[0, 2000]]));
    expect(r.segments).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });

  it('低置信度截断：no_speech 高且 logprob 低；compression 超限', () => {
    const a = seg(1, 0, 1000, 'x', { noSpeechProb: 0.7, avgLogprob: -1.0 });
    const b = seg(2, 1000, 2000, 'y', { compressionRatio: 2.5 });
    const c = seg(3, 2000, 3000, '正常', { noSpeechProb: 0.2, avgLogprob: -0.2, compressionRatio: 1.1 });
    const r = guardSegments([a, b, c], null);
    expect(r.segments.map((s) => s.segId)).toEqual([3]);
  });

  it('复读折叠：CJK 连续单字与拉丁词组', () => {
    const r = guardSegments([seg(1, 0, 3000, '哈哈哈哈大家好')], null);
    expect(r.segments[0]?.text).toBe('哈大家好');
    const r2 = guardSegments([seg(1, 0, 3000, 'ok ok ok go')], null);
    expect(r2.segments[0]?.text).toBe('ok go');
  });

  it('整段复读折叠为单次保留', () => {
    const r = guardSegments([seg(1, 0, 3000, '嗯嗯嗯嗯嗯')], null);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]?.text).toBe('嗯');
  });

  it('黑名单：短独立句命中剔除，正常语句不误伤', () => {
    const r = guardSegments(
      [seg(1, 0, 500, '请不吝点赞 订阅频道'), seg(2, 500, 2500, '今天我们讲第一节课的内容')],
      null,
    );
    expect(r.segments.map((s) => s.text)).toEqual(['今天我们讲第一节课的内容']);
  });

  it('emoji 清洗：剥离音乐/表情符号，正常台词不误伤', () => {
    const r = guardSegments(
      [seg(1, 0, 6000, 'Yeah.🎼 团长到。😡诸威。马某此番受督军栽培')],
      null,
    );
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]?.text).toBe('Yeah. 团长到。 诸威。马某此番受督军栽培');
  });

  it('emoji 清洗：纯符号段剥空后整段剔除', () => {
    const r = guardSegments([seg(1, 0, 2000, '🎼🎵😡')], null);
    expect(r.segments).toHaveLength(0);
    expect(r.dropped).toBe(1);
  });

  it('stripEmoji 纯函数：CJK/全角标点不受影响', () => {
    expect(stripEmoji('Yeah.🎼 团长到。😡诸威。')).toBe('Yeah. 团长到。 诸威。');
    expect(stripEmoji('🎼🎵😡')).toBe('');
    expect(stripEmoji('你好，世界！')).toBe('你好，世界！');
  });

  it('stripEmoji 空白收拢：全角空格与 emoji 遗留空白一并归一', () => {
    expect(stripEmoji('🎼\u3000歌词继续')).toBe('歌词继续');
    expect(stripEmoji('a\t🎼\u3000b')).toBe('a b');
    expect(guardSegments([seg(1, 0, 1000, '🎼\u3000')], null)).toEqual({ segments: [], dropped: 1 });
  });

  it('foldRepeats 纯函数', () => {
    expect(foldRepeats('哈哈哈哈的')).toBe('哈的');
    expect(foldRepeats('ok ok ok go')).toBe('ok go');
    expect(foldRepeats('没有重复的句子')).toBe('没有重复的句子');
    expect(foldRepeats('，。')).toBeNull();
  });

  it('speechRateCps：按岛时长归一', () => {
    const vad = vadOf([], [[0, 2000]]);
    expect(speechRateCps([seg(1, 0, 2000, '一二三四五六七八九十')], vad)).toBe(5);
    expect(speechRateCps([seg(1, 0, 2000, '一二三')], null)).toBeNull();
  });
});
