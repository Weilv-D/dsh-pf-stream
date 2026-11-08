/** case24：单帧视频（末帧 PTS=0）——pf_stream 通道单帧可见性修复的回归 fixture。 */
import { ensureFixture } from './lib.mjs';

ensureFixture('case24_single_frame.mp4', [
  '-f', 'lavfi',
  '-i', 'color=c=red:s=320x240:d=0.04',
  '-frames:v', '1',
  '-r', '25',
  '-pix_fmt', 'yuv420p',
]);
console.log('case24_single_frame.mp4 已就绪');
