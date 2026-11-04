/**
 * case 2 fixture：末尾 duration 避让。
 * - case02_plain.mp4：640x360@30fps 3s，末帧 PTS=2966.67ms，标称 3000ms；
 * - case02_blacktail.mp4：同源 concat 100ms 黑尾，标称时长被拉偏。
 */
import { ensureFixture } from './lib.mjs';

const plain = ensureFixture('case02_plain.mp4', [
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
]);

const blacktail = ensureFixture('case02_blacktail.mp4', [
  '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
  '-f', 'lavfi', '-i', 'color=black:size=640x360:rate=30:duration=0.1',
  '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
  '-map', '[v]',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
]);

console.log(JSON.stringify({ plain, blacktail }));
