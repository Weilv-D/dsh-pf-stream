/**
 * 音频 fixture ①：3s 视频，静音底 + 0.8–1.6s 的 440Hz 语音岛。
 * 覆盖：VAD 静音短路、语音岛提取、A2 短路不触发 ASR。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureFixture, MEDIA_DIR } from './lib.mjs';

mkdirSync(join(MEDIA_DIR, '.sub-src'), { recursive: true });

const out = ensureFixture('case_audio_silence.mp4', [
  '-f', 'lavfi', '-i', 'color=c=0x101010:s=320x240:r=10:d=3',
  '-f', 'lavfi', '-i',
  'aevalsrc=0.55*sin(2*PI*440*t)*between(t\\,0.8\\,1.6):s=16000:d=3',
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '48k',
  '-shortest',
]);
console.log(out);
