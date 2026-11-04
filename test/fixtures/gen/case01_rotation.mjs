/**
 * case 1 fixture：竖拍 90°/270° 旋转测试流。
 * 生成两步：先编码基础流（1080x1920 编码竖长），再经 remux 写入 display matrix
 * （-display_rotation 为输入选项，配合 -c copy 由 mov muxer 写入 Display Matrix）。
 * ffprobe 对 270° 报告 rotation=-90（归一化到 [-90,180] 区间），解析层须归一为 270。
 * tags.rotate 旧式路径无法由 ffmpeg 8 生成，其解析由单测用合成 ffprobe JSON 覆盖。
 */
import { ensureFixture } from './lib.mjs';

const base = ensureFixture('case01_base.mp4', [
  '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=2',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
]);

// ensureFixture 以「argv + 输出名」追加输出文件；remux 步输入显式置于 argv 内。
const rot90 = ensureFixture('case01_rot90.mp4', [
  '-display_rotation', '90', '-i', base, '-c', 'copy',
]);

const rot270 = ensureFixture('case01_rot270.mp4', [
  '-display_rotation', '270', '-i', base, '-c', 'copy',
]);

console.log(JSON.stringify({ base, rot90, rot270 }));
