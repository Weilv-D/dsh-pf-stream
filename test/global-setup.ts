/**
 * vitest globalSetup：幂等生成全部 fixture（首跑生成、指纹缓存）。
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export default function setup(): void {
  const scripts = ['case01_rotation.mjs', 'case02_tail.mjs', 'case03_viewport.mjs', 'case04_modulus.mjs'].map(
    (name) => join(HERE, 'fixtures', 'gen', name),
  );
  for (const script of scripts) {
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true });
    if (run.status !== 0) {
      throw new Error(`fixture 生成失败：${script}\n${run.stderr}`);
    }
  }
}
