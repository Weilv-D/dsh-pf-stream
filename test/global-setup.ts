/**
 * vitest globalSetup：幂等生成全部 fixture（首跑生成、指纹缓存）。
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export default function setup(): void {
  const genDir = join(HERE, 'fixtures', 'gen');
  const scripts = readdirSync(genDir)
    .filter((name) => name.endsWith('.mjs') && name !== 'lib.mjs')
    .sort()
    .map((name) => join(genDir, name));
  for (const script of scripts) {
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true });
    if (run.status !== 0) {
      throw new Error(`fixture 生成失败：${script}\n${run.stderr}`);
    }
  }
}
