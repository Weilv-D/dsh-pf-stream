/**
 * 用例 6 补充 fixture：高对比度纹理微振。
 *
 * testsrc2（高对比纹理）经慢速正弦亚像素漂移视窗（±2px @ 0.3Hz），
 * 每帧内容位移约 0.13px：梯度 ḡ 高、原始帧差 δ_raw 低。
 * 梯度归一化后 d_t 应低于 H_low=0.05 —— 全程不出 P 单元。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mediaDir = join(here, '..', 'media');
const out = join(mediaDir, 'case06d_micro_shake.mp4');
const marker = join(mediaDir, '.case06d_generated');

if (!existsSync(marker)) {
  mkdirSync(mediaDir, { recursive: true });
  const args = [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3',
    '-vf',
    "crop=636:356:'2+2*sin(t*2*PI*0.3)':'2+2*cos(t*2*PI*0.3)',pad=640:360:0:0:color=black",
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    out,
  ];
  const run = spawnSync('ffmpeg', args, { stdio: 'pipe', windowsHide: true });
  if (run.status !== 0) throw new Error(`ffmpeg fixture 生成失败：${run.stderr}`);
  writeFileSync(marker, 'ok');
}
