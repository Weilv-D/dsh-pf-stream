/**
 * M2 流式感知 fixture（用例 5/6/7/9/19 的 lavfi 构造）。
 *
 * 运动内容用 geq 逐像素表达式驱动（T 变量）：本机 ffmpeg 8（gyan full）实测
 * drawbox/crop 的 x/y 动画表达式不随帧推进，geq 的 T 逐帧求值可靠。
 *
 * 运动图案选「块对齐棋盘翻转」而非平移方块，理由（fixture 调参实测结论）：
 * 1. 平移方块的 δ_raw 随每步位移线性增长，未饱和时积分速率 A/s ∝ 步长²，
 *    24 与 60fps 的 P 产出偏差约 25%，无法通过步长归一化对齐；
 * 2. 块对齐棋盘（80×90px = 恰好一个感知块）每步整块刷新，δ_raw 饱和于
 *    块对比度，δ 与步长无关 → d=1.0 恒定，A/s = α·d·30·(ΔPTS/33.3) 严格帧率无关；
 * 3. 棋盘相位每步翻转 → r_flip≈1 → α=0.1（频闪抑制），P 速率 = 3.0/s，
 *    落在 maxPackets 预算内（4s ≈ 20 包）；
 * 4. 棋盘翻转的灰度直方图不变（两相位同分布）→ D_hist=0 → 判 WHIP 不误报 SWITCH。
 *
 * - case05_motion：640×360@30fps 4s 棋盘翻转（持续 MOTION 载体）；
 * - case06a/b：同一内容 24/60fps 版本（步长对齐对照）；
 * - case06c_dark：24fps 低对比度全帧闪烁（梯度归一化标定）；
 * - case07a_hardcut：亮纹理段 → 暗纹理段（32 块 δ_raw≈0.63 全越限 + histL1≈1.9 → SWITCH；
 *   testsrc2→smptebars 方案块级变化不足 26 块，实测判 WHIP，弃用）；
 * - case07b_whip：全帧正弦纹理 2000px/s 平移（灰度分布连续 → WHIP）；
 * - case09_blackcut：半屏翻转(255/128) 1.5s → 纯黑 0.25s → 静止灰 1.75s →
 *   完整门控翻转周期 1.9s（SWITCH 原子清理 + F_switch 黑场顺延 + R4 双恢复路径）。
 *   黑段取 0.25s：出黑时刻(1750)在 300ms 顺延上限内，黑→灰本身构成第二次硬切，
 *   F_switch 按规格原子步骤 6 重捕于首个正常帧；半屏取 {255,128} 保证入黑时
 *   32 块 δ_raw 全部 >0.3（{0,255} 的暗半 0→0 不变化，仅 16 块越限，判不了 SWITCH）；
 * - case19_vfr：60fps 与 20fps 两段独立编码（mpegts 中间容器）后
 *   concat demuxer 流复制（TS 携带显式 PTS，50ms 步长不丢失）。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureFixture, MEDIA_DIR } from './lib.mjs';

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p'];

/** 门控左右半屏翻转（2.5s 周期：0.15s 渐入 → 0.85s 全幅翻转 → 0.5s 渐出 → 1.5s 静止）。
 * 渐入渐出避免「运动↔静止」电平跳变被硬切判据误捕（瞬时 |ΔI|>0.3 且直方图整体迁移）；
 * 翻转段：320px 分界两侧纯色整块翻转 → δ 钳位 1，d=1.0 饱和，直方图两相位同分布
 * → D_hist=0 判 WHIP；渐出段 d 单调降至 hLow 下 → SETTLE 锁定 → PATH_SETTLE 含 F 包；
 * 静止段 1.5s 覆盖 T_settle 与心跳观察窗。幅度可调（暗光版 24/96）。 */
const gatedHalvesGeq = (lo = 0, hi = 255) => {
  const phase = 'floor(X/320)+floor(T*30+0.5)';
  const ramp = 'max(0\\,min(1\\,min(mod(T\\,2.5)/0.15\\,(1.5-mod(T\\,2.5))/0.5)))';
  const lum = `lum='128+${ramp}*((${lo}+${hi - lo}*between(mod(${phase}\\,2)\\,0.5\\,1.5))-128)':cb=128:cr=128`;
  return lum;
};

/** 无门控半屏翻转（255/128，30Hz 相位翻转；块内纯色，δ 饱和 1，直方图双相位同分布）。 */
const plainHalvesGeq = () => {
  const phase = 'floor(X/320)+floor(T*30+0.5)';
  return `lum='128+127*between(mod(${phase}\\,2)\\,0.5\\,1.5)':cb=128:cr=128`;
};

function motion(name, rate, duration, geq) {
  return ensureFixture(name, [
    '-f', 'lavfi',
    '-i', `nullsrc=s=640x360:r=${rate}:d=${duration}`,
    '-vf', `geq=${geq}`,
    ...X264,
  ]);
}

// case05：门控半屏翻转 30fps 4s（两轮 MOTION→SETTLE 周期，P 流 + settle F）
motion('case05_motion.mp4', 30, 4, gatedHalvesGeq());

// case06：24/60fps 步长对齐 + 暗光低对比度
motion('case06a_fps24.mp4', 24, 3, gatedHalvesGeq());
motion('case06b_fps60.mp4', 60, 3, gatedHalvesGeq());
motion('case06c_dark.mp4', 24, 3, gatedHalvesGeq(24, 96));

// case07a：硬切（亮纹理 → 暗纹理：32 块 δ_raw≈0.63 全越限，histL1≈1.9）
ensureFixture('case07a_hardcut.mp4', [
  '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=2',
  '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=2',
  '-filter_complex', [
    "[0:v]geq=lum='200+25*sin(X/37+Y/53)':cb=128:cr=128[s0]",
    "[1:v]geq=lum='40+20*sin(X/29+Y/41)':cb=128:cr=128[s1]",
    '[s0][s1]concat=n=2:v=1:a=0',
  ].join(';'),
  ...X264,
]);

// case07b：极速甩镜（全帧正弦纹理 2000px/s 平移，灰度分布连续）
ensureFixture('case07b_whip.mp4', [
  '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=4',
  '-vf', "geq=lum='128+30*sin((X+T*2000)/24)':cb=128:cr=128",
  ...X264,
]);

// case09：四段（半屏翻转 → 纯黑 0.25s → 静止灰 → 完整门控翻转周期）
{
  const seg = (i, expr) => `[${i}:v]geq=${expr}[s${i}]`;
  const plainHalves = plainHalvesGeq();
  const black = "lum='0':cb=128:cr=128";
  const gray = (v) => `lum='${v}':cb=128:cr=128`;
  ensureFixture('case09_blackcut.mp4', [
    '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=1.5',
    '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=0.25',
    '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=1.75',
    '-f', 'lavfi', '-i', 'nullsrc=s=640x360:r=30:d=1.9',
    '-filter_complex', [
      seg(0, plainHalves),
      seg(1, black),
      seg(2, gray(128)),
      seg(3, gatedHalvesGeq(128, 255)),
      '[s0][s1][s2][s3]concat=n=4:v=1:a=0',
    ].join(';'),
    ...X264,
  ]);
}

// case19：两段独立编码 → concat demuxer 流复制（PTS 节奏保留）。
// 用 mpegts 中间容器：TS 携带显式分组 PTS，concat 流复制不会把 20fps 段重定时到 60fps 网格
// （mp4 中间容器 concat 时会按首流节拍重写时间戳，实测 50ms 步长丢失）。
{
  ensureFixture('case19_seg60.ts', [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=60:duration=2',
    ...X264, '-f', 'mpegts',
  ]);
  ensureFixture('case19_seg20.ts', [
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20:duration=2',
    ...X264, '-f', 'mpegts',
  ]);
  mkdirSync(MEDIA_DIR, { recursive: true });
  const listPath = join(MEDIA_DIR, 'case19_list.txt');
  writeFileSync(listPath, "file 'case19_seg60.ts'\nfile 'case19_seg20.ts'\n");
  ensureFixture('case19_vfr.mp4', ['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy']);
}
