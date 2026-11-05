/**
 * 音频 fixture ②：3s 视频 + 静音音轨 + 内嵌两条 mov_text 字幕轨（zh/en）。
 * 覆盖：内嵌选轨（zh 优先于 en）、probe 字幕导航、外挂优先级（测试内复制后加外挂）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureFixture, MEDIA_DIR } from './lib.mjs';

const srcDir = join(MEDIA_DIR, '.sub-src');
mkdirSync(srcDir, { recursive: true });
const zh = join(srcDir, 'sub-zh.srt');
const en = join(srcDir, 'sub-en.srt');
writeFileSync(zh, '1\n00:00:00,400 --> 00:00:01,200\n第一句字幕内容\n\n2\n00:00:01,500 --> 00:00:02,500\n第二句字幕内容\n', 'utf8');
writeFileSync(en, '1\n00:00:00,400 --> 00:00:01,200\nfirst subtitle line\n\n2\n00:00:01,500 --> 00:00:02,500\nsecond subtitle line\n', 'utf8');

const out = ensureFixture('case_audio_sub.mp4', [
  '-f', 'lavfi', '-i', 'color=c=0x202020:s=320x240:r=10:d=3',
  '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono',
  '-i', zh, '-i', en,
  '-map', '0:v', '-map', '1:a', '-map', '2:s', '-map', '3:s',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '32k',
  '-c:s', 'mov_text',
  '-metadata:s:s:0', 'language=chi',
  '-metadata:s:s:1', 'language=eng',
  '-shortest',
]);
console.log(out);
