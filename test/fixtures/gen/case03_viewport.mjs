/**
 * case 3 fixture —— 视窗裁剪与短边保护：
 * - wide 3840×2160（16:9 源）
 * - tall 2160×4096（超竖长源）
 * - tiny 60×60（源短边物理上 <84：内容级补边路径）
 */

import { ensureFixture } from './lib.mjs';

ensureFixture('case03_wide.mp4', [
  '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=30:duration=2',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
]);

ensureFixture('case03_tall.mp4', [
  '-f', 'lavfi', '-i', 'testsrc2=size=2160x4096:rate=30:duration=2',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
]);

ensureFixture('case03_tiny.mp4', [
  '-f', 'lavfi', '-i', 'testsrc2=size=60x60:rate=30:duration=2',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
]);
