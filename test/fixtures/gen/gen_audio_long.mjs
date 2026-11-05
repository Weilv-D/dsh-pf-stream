/**
 * 音频 fixture ③：80s 视频，语音岛 [0,10] [20,30] [40,50] [60,70]，岛间静音谷。
 * 覆盖：长窗切分（谷底中点）、跨片段时间戳锚定（A5）。
 */
import { ensureFixture } from './lib.mjs';

const islandExpr =
  '0.55*sin(2*PI*440*t)*(between(t\\,0\\,10)+between(t\\,20\\,30)+between(t\\,40\\,50)+between(t\\,60\\,70))';

const out = ensureFixture('case_audio_long.mp4', [
  '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=2:d=80',
  '-f', 'lavfi', '-i', `aevalsrc=${islandExpr}:s=16000:d=80`,
  '-map', '0:v', '-map', '1:a',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '48k',
  '-shortest',
]);
console.log(out);
