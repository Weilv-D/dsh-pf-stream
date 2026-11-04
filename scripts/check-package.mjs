#!/usr/bin/env node
/**
 * 包内容白名单审计：npm pack 产物必须与 package.json files 白名单完全一致。
 * 前置：pnpm run build（lib/ 必须存在）。
 * 退出码 0 = 一致；非 0 = 存在多余或缺失条目。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p.split('\\').join('/'));
  }
  return out;
}

const expected = new Set(['package.json']);
for (const entry of pkg.files ?? []) {
  if (!existsSync(entry)) {
    console.error(`FAIL files 条目不存在：${entry}（先运行 pnpm run build）`);
    process.exit(1);
  }
  if (statSync(entry).isDirectory()) {
    for (const f of walk(entry)) expected.add(f);
  } else {
    expected.add(entry.split('\\').join('/'));
  }
}

const isWin = process.platform === 'win32';
const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  shell: isWin,
});
if (pack.status !== 0) {
  console.error(pack.error?.message ?? pack.stderr ?? pack.stdout ?? 'npm pack --dry-run 失败');
  process.exit(1);
}
const packed = JSON.parse(pack.stdout)[0].files.map((f) => f.path);

const extra = packed.filter((f) => !expected.has(f));
const missing = [...expected].filter((f) => !packed.includes(f));
if (extra.length > 0 || missing.length > 0) {
  for (const f of extra) console.error(`FAIL 多余条目：${f}`);
  for (const f of missing) console.error(`FAIL 缺失条目：${f}`);
  process.exit(1);
}
console.log(`PASS 包内容与 files 白名单一致（${packed.length} 个文件）`);
