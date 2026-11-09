/** case25：SWITCH 硬切入纯黑场 ≥250ms + 渐显——F_switch 顺延/兜底与跨窗口死线续接回归。 */
import { ensureFixture } from './lib.mjs';

ensureFixture('case25_black_defer.mp4', [
  '-f', 'lavfi',
  '-i', 'testsrc2=size=320x240:rate=30:duration=0.95',
  '-f', 'lavfi',
  '-i', 'color=c=black:size=320x240:rate=30:duration=0.35',
  '-f', 'lavfi',
  '-i', 'color=c=white:size=320x240:rate=30:duration=1.1,fade=t=in:st=0:d=0.6',
  '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
  '-map', '[out]',
  '-pix_fmt', 'yuv420p',
]);
console.log('case25_black_defer.mp4 已就绪');
