/**
 * golden 基准比对（规格《八》§3 e2e 交付形态）：
 * 首跑写入 test/golden/<name>.json 作为基准；复跑与基准严格字符串比对。
 * 基准内容只锁 PTS 序列、形态与触发路径——不含墙钟遥测与图像 SHA
 * （fixture 因 ffmpeg 版本差异重新生成时，时间结构不变即不破坏基准）。
 *
 * 需要重置基准时删除对应 json 文件后重跑一次即可。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect } from 'vitest';

const GOLDEN_DIR = join(process.cwd(), 'test', 'golden');

export async function expectGolden(name: string, data: unknown): Promise<void> {
  const file = join(GOLDEN_DIR, `${name}.json`);
  const actual = `${JSON.stringify(data, null, 2)}\n`;
  let expected: string | null = null;
  try {
    expected = await readFile(file, 'utf8');
  } catch {
    // 首跑：落盘基准后通过
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, actual, 'utf8');
    return;
  }
  expect(actual).toBe(expected);
}

/** 包序列的稳定摘要（golden 载荷构造用）。 */
export interface PacketDigest {
  packetId: number;
  layoutForm: string;
  triggerPath: string;
  anchorFId: number | null;
  units: Array<{ globalId: number; timestampMs: number; scale: string }>;
}
