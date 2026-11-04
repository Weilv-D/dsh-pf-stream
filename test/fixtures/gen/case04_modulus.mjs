/**
 * case 4 fixture —— 42px 模数与 530 Tokens：
 * - plain 1920×1080（触发 FORM_1 组合切片）
 */

import { ensureFixture } from './lib.mjs';

ensureFixture('case04_plain.mp4', [
  '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=3',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
]);
