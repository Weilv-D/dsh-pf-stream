/**
 * M3 自闭环 fixture（用例 13/14 的 lavfi 构造）。
 *
 * - case13_flicker_cut：半屏翻转(255/128) 2s → 暗纹理 1s → 静止灰 3s。
 *   半屏翻转 r_flip≈1（R3 载体）；翻转中的硬切（→暗纹理）验证 H_switch 固定
 *   0.10 与 R3 抬高后的 H_high_eff 解耦；静止尾驱动 R3 十帧恢复。
 * - case14_slow：慢速平移纹理方块（R1 载体，d 落在 (hLow, 1.2×H_high) 带）；
 * - case14_fast：全帧正弦纹理高速平移（R2 载体，滑动均值 > 3×H_high）；
 *   两 fixture 均带静止尾（R1/R2 退出 MOTION 恢复 + SETTLE 收尾）。
 */

import { ensureFixture, MEDIA_DIR } from './lib.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];

/** 半屏翻转（255/128，30Hz 相位对翻）。 */
const halvesLum = () => {
  const phase = 'floor(X/320)+floor(T*30+0.5)';
  return `lum='128+127*between(mod(${phase}\\,2)\\,0.5\\,1.5)':cb=128:cr=128`;
};

/** R1 载体：左半屏三角波对比度调制（δ 恒定落在 (H_high, 1.2×H_high) 带内持续 MOTION）。
 *  A_tri(t) = 55·(1−2·|frac(t/0.8)−0.5|)，|dA/dt| ≈ 137 灰阶/s；
 *  左半块内纯色缓慢同步漂移（空间梯度≈0），d ≈ 0.11 ∈ (0.10, 0.12)；右半恒 128。 */
const slowBandLum = () =>
  `lum='128+lt(X\\,320)*55*(1-2*abs(mod(T/0.8\\,1)-0.5))':cb=128:cr=128`;

/** R2 载体：80px 随机亮度格带按 2400px/s 平移（每帧恰好位移一格）。
 *  块内容被随机邻格整体替换 → δ_raw≈0.26、块内纯色 ḡ≈0 → d≈0.7 >> 3×H_high；
 *  随机电平使相邻两步像素 Δ 符号近似独立 → r_flip≈0.5，不触发 R3 冻结；
 *  每帧展示同一组电平（整体移位一格）→ 直方图时不变，无硬切候选（δ_raw 均值 <0.3）。 */
const translatingSineLum = () =>
  `lum='20+200*mod(st(0\\,floor((X-2400*T)/80)*12.9898)*43758.5453\\,1)':cb=128:cr=128`;

/** 静止灰。 */
const grayLum = (v) => `lum='${v}':cb=128:cr=128`;

/** 多段 concat 编码。 */
function segments(name, segs) {
  const inputs = [];
  for (const [i, [dur, expr]] of segs.entries()) {
    inputs.push('-f', 'lavfi', '-i', `nullsrc=s=640x360:r=30:d=${dur}`);
  }
  const filters = segs
    .map(([_, expr], i) => `[${i}:v]geq=${expr}[s${i}]`)
    .concat([`${segs.map((_, i) => `[s${i}]`).join('')}concat=n=${segs.length}:v=1:a=0`])
    .join(';');
  return ensureFixture(name, [...inputs, '-filter_complex', filters, ...X264]);
}

// case13：频闪源中插入硬切（R3 激活期间 H_switch 固定 0.10 仍触发）
segments('case13_flicker_cut.mp4', [
  [2.0, halvesLum()],
  [1.0, "lum='40+20*sin(X/29+Y/41)':cb=128:cr=128"],
  [3.0, grayLum(128)],
]);

// case14 slow：左半屏三角波对比度调制（R1）
segments('case14_slow.mp4', [
  [4.0, slowBandLum()],
  [1.5, grayLum(128)],
]);

// case14 fast：高速正弦平移（R2）
segments('case14_fast.mp4', [
  [4.0, translatingSineLum()],
  [1.5, grayLum(128)],
]);

// 保留：告诉 ensureFixture 产物目录（无实际作用，避免 tree-shake 误删 import）
writeFileSync(join(MEDIA_DIR, '.case13_14_generated'), String(Date.now()));
