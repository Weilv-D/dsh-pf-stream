/**
 * 用例 8 fixture：EMA 预热保护验证（v3：门控翻转载体）。
 *
 * 载体选择（testsrc2 方案废弃原因：移动元素在 64×36 感知域过小，
 * 清晰段 d≈0.06 全程 STATIC，无法形成对照）。
 *
 * 结构（640×360@30fps，共 3.0s）：
 *   [0, 500)    纯灰 128 —— STATIC 前置；
 *   [500, 1000) 门控翻转（0.15s 渐入 + 0.35s 翻转）整体 gblur sigma=8 ——
 *               MOTION 进入点 ≈580ms，3 帧预热期（≈580-680）全部落在模糊段；
 *   [1000, 3000) 同一门控周期的清晰续段（0.35s 翻转 + 0.5s 渐出 + 1.0s 静止）——
 *               梯度跳升后 PEAK 擂台与 SETTLE 观察窗均被清晰帧占据。
 *
 * 断言依据：预热期内的模糊帧不得成为发出的 F；SETTLE 观察窗锁定的
 * F 落在清晰段（渐出前的高 g 帧）。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureFixture } from './lib.mjs';

const GATED_HALVES =
  "lum='128+max(0\\,min(1\\,min(mod(T\\,2.5)/0.15\\,(1.5-mod(T\\,2.5))/0.5)))*" +
  "(0+255*between(mod(floor(X/320)+floor(T*30+0.5)\\,2)\\,0.5\\,1.5)-128)':cb=128:cr=128";

const out = ensureFixture('case08_ema_warmup.mp4', [
  '-y',
  '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=0.5',
  '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=2.5',
  '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=2.5',
  '-filter_complex',
  `[0:v]geq=lum='128':cb=128:cr=128[a];` +
    `[1:v]geq=${GATED_HALVES},gblur=sigma=8,trim=0:0.5,setpts=PTS-STARTPTS[b];` +
    `[2:v]geq=${GATED_HALVES},trim=0.5:2.5,setpts=PTS-STARTPTS[c];` +
    `[a][b][c]concat=n=3:v=1:a=0[out]`,
  '-map', '[out]',
  '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
]);

export default out;

// 独立直跑支持（import 形态下 ensureFixture 已执行）
if (import.meta.url === `file://${process.argv[1]}`) {
  void out;
}
