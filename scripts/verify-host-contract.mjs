#!/usr/bin/env node
/**
 * 宿主契约静态自检（设计文档 §2.2b 承诺的可执行核对，无需宿主运行时）。
 *
 * 核对项（依据 cordis-plugin-development 与宿主 harness 实证）：
 *  1. 工具 parameters 为 schemastery 值 schema 的「属性名 → 值 schema」映射，
 *     不写成完整 JSON Schema（宿主拒装：parameters.type must be a value schema object）；
 *  2. 值 schema 只使用宿主允许的关键字集合
 *     { type, oneOf, properties, required, additionalProperties, items, enum, const, description }，
 *     数值边界由入口适配器钳制实现，Schema 层出现 minimum/pattern 等会被 apply 期拒装；
 *  3. package.json：@deepseek-ai/cordis 与 @deepseek-ai/schemastery 声明为
 *     peerDependencies（运行时依赖仅 pngjs——ADR-006 零原生依赖红线）；
 *  4. 依赖闭包无原生模块（排除 optional peer 与 devDependencies）。
 *
 * 退出码：0 = 全部通过；1 = 存在违规（输出违规清单）。
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const passes = [];

function check(name, ok, detail) {
  if (ok) passes.push(name);
  else failures.push(`${name}${detail ? `：${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 1/2. 工具 schema 形状与关键字允许集
// ---------------------------------------------------------------------------
const { toolParameters } = await import(pathToFileURL(join(root, 'lib', 'tool', 'schema.js')).href);

check(
  'toolParameters 为对象（schemastery 属性映射形态，非 {type:"object"} 完整 JSON Schema）',
  typeof toolParameters === 'object' && toolParameters !== null && toolParameters.type !== 'object',
  `实际类型 ${typeof toolParameters}`,
);

// 宿主允许集（宿主 assertSupportedJsonSchema 允许集实证）：
// 数值边界由入口适配器钳制实现（src/tool/schema.ts 头注），Schema 层不使用。
const ALLOWED_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'description',
]);

function walkSchema(node, path) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkSchema(child, `${path}[${i}]`));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (!ALLOWED_KEYS.has(key)) {
        failures.push(`schema 关键字越界：${path}.${key}`);
      } else if (key === 'properties' && value !== null && typeof value === 'object') {
        // properties 的 value 是「属性名 → 值 schema」映射：属性名不检查，逐值递归
        for (const [prop, child] of Object.entries(value)) {
          walkSchema(child, `${path}.properties.${prop}`);
        }
      } else {
        walkSchema(value, `${path}.${key}`);
      }
    }
  }
}
const beforeFailures = failures.length;
// 顶层是「属性名 → 值 schema」映射：属性名不是关键字，逐值 schema 内部检查
for (const [prop, schema] of Object.entries(toolParameters)) {
  walkSchema(schema, `toolParameters.${prop}`);
}
check('工具 schema 关键字全部落在宿主允许集', failures.length === beforeFailures);

// 值 schema 必填字段存在
check(
  'video_path 入参存在且为 string',
  toolParameters.video_path?.type === 'string',
);
check('intent 入参存在（object）', toolParameters.intent?.type === 'object');

// ---------------------------------------------------------------------------
// 3. package.json 依赖形态
// ---------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const peer = pkg.peerDependencies ?? {};
const deps = pkg.dependencies ?? {};

check(
  '@deepseek-ai/cordis 声明为 peerDependencies',
  peer['@deepseek-ai/cordis'] !== undefined,
);
check(
  '@deepseek-ai/schemastery 声明为 peerDependencies',
  peer['@deepseek-ai/schemastery'] !== undefined,
);
check(
  '运行时依赖仅 pngjs（零原生依赖红线，ADR-006）',
  Object.keys(deps).length === 1 && deps.pngjs !== undefined,
  `实际 dependencies：${Object.keys(deps).join(', ') || '(空)'}`,
);

// ---------------------------------------------------------------------------
// 4. 依赖闭包无原生模块（安装形态审计；开发依赖除外）
// ---------------------------------------------------------------------------
const NATIVE_HINTS = /node-gyp|node-pre-gyp|prebuild-install|node-addon-api/i;
let nativeViolations = '';
try {
  const lockRaw = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  // 粗筛：pngjs 闭包（pngjs → 在 pnpm-lock 中无原生依赖块）
  if (NATIVE_HINTS.test(lockRaw)) {
    // pnpm-lock 可能包含其他工作区包；只检查 pngjs 段
    const pngjsSection = lockRaw.split(/pngjs@/).slice(1).join('');
    if (NATIVE_HINTS.test(pngjsSection)) nativeViolations = 'pngjs 闭包含原生构建工具';
  }
} catch {
  // lock 文件缺失不视为违规（本地开发生成前）
}
check('pngjs 依赖闭包无原生构建链', nativeViolations === '', nativeViolations);

// ---------------------------------------------------------------------------
// 5. cordis.patch.yml 装载清单形状（宿主安装器要求：顶层数组，元素为
//    { insert: [ { id, name, ... } ] } 装载补丁；宿主 dsh.bundle.patch 校验）
// ---------------------------------------------------------------------------
const overlayRaw = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
const overlayLines = overlayRaw
  .split(/\r?\n/)
  .map((line) => line.replace(/#.*$/, '').trimEnd())
  .filter((line) => line.trim() !== '');
const firstEntry = overlayLines[0] ?? '';
const insertRows = overlayLines.filter((line) => /^\s+(-\s+)?(id|name):/.test(line));
check(
  'cordis.patch.yml 顶层为装载补丁数组（首个非注释行为 "- insert:"）',
  /^-\s*insert:\s*$/.test(firstEntry),
  `实际首行：${JSON.stringify(firstEntry)}`,
);
check(
  '装载补丁 insert 行含 id 与 name 字段',
  insertRows.some((line) => /^\s+(-\s+)?id:/.test(line)) && insertRows.some((line) => /^\s+(-\s+)?name:/.test(line)),
  `实际行：${insertRows.join(' | ')}`,
);
// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
for (const p of passes) console.log(`  PASS  ${p}`);
for (const f of failures) console.error(`  FAIL  ${f}`);
console.log(
  failures.length === 0
    ? `宿主契约自检通过（${passes.length} 项）`
    : `宿主契约自检失败：${failures.length} 项违规`,
);
process.exit(failures.length === 0 ? 0 : 1);
