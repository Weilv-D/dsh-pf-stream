#!/usr/bin/env node
/**
 * 宿主契约静态自检（设计文档 §2.2b 承诺的可执行核对，无需宿主运行时）。
 *
 * 核对项（依据 cordis-plugin-development 与宿主 harness 实证）：
 *  1. 工具 parameters 为标准 JSON Schema 根对象 {type:"object", properties,
 *     required, additionalProperties}。本插件经 ctx.tools.register() 注册，
 *     宿主对该路径的 parameters 不做归一化、原样投影给模型（schemaOf()）；
 *     「属性名 → 值 schema」映射形式只在 defineTool() 路径归一化，register()
 *     路径使用会令模型端把工具视为无参数。
 *  2. 值 schema 只使用保守关键字集合
 *     { type, properties, required, additionalProperties, items, enum, const, description }，
 *     数值边界由入口适配器钳制实现（src/tool/schema.ts 头注）。
 *  3. package.json：@deepseek-ai/cordis 与 @deepseek-ai/schemastery 声明为
 *     peerDependencies（运行时依赖仅 pngjs + zod——ADR-006 零原生依赖红线；
 *     zod 为 storageDomain 记录 schema 所需，见 src/session/persistence.ts）；
 *     engines.dsh 声明宿主版本要求（插件市场以此显示宿主要求，未声明会显示
 *     「未声明宿主要求」；宿主以 semver.satisfies(运行时, 范围, includePrerelease)
 *     判定）。
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
  'toolParameters 为标准 JSON Schema 根对象（{type:"object", properties, required}）',
  toolParameters?.type === 'object' &&
    toolParameters.properties !== null &&
    typeof toolParameters.properties === 'object' &&
    Array.isArray(toolParameters.required),
  `实际 type=${toolParameters?.type}`,
);

// 保守关键字集（数值边界由入口适配器钳制实现，src/tool/schema.ts 头注）：
const ALLOWED_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'description',
]);

function walkSchema(node, path, violations) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkSchema(child, `${path}[${i}]`, violations));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (!ALLOWED_KEYS.has(key)) {
        violations.push(`schema 关键字越界：${path}.${key}`);
      } else if (key === 'properties' && value !== null && typeof value === 'object') {
        // properties 的 value 是「属性名 → 值 schema」映射：属性名不检查，逐值递归
        for (const [prop, child] of Object.entries(value)) {
          walkSchema(child, `${path}.properties.${prop}`, violations);
        }
      } else {
        walkSchema(value, `${path}.${key}`, violations);
      }
    }
  }
}
const schemaKeyViolations = [];
// 根对象自带 type/properties/required/additionalProperties；逐属性值 schema 内部检查
for (const [prop, schema] of Object.entries(toolParameters.properties)) {
  walkSchema(schema, `toolParameters.properties.${prop}`, schemaKeyViolations);
}
check('工具 schema 关键字全部落在允许集', schemaKeyViolations.length === 0, schemaKeyViolations.join('；'));

// 必填字段存在（root schema 形态）
check(
  'video_path 入参存在且为 string',
  toolParameters.properties.video_path?.type === 'string',
);
check(
  'video_path 列入 required',
  Array.isArray(toolParameters.required) && toolParameters.required.includes('video_path'),
);
check(
  'intent 入参存在（object）',
  toolParameters.properties.intent?.type === 'object',
);

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
  '运行时依赖仅 pngjs + zod（零原生依赖红线，ADR-006；zod 为 storageDomain 记录 schema）',
  Object.keys(deps).length === 2 && deps.pngjs !== undefined && deps.zod !== undefined,
  `实际 dependencies：${Object.keys(deps).join(', ') || '(空)'}`,
);

// ---------------------------------------------------------------------------
// 3b. engines.dsh 宿主版本要求声明（插件市场按此显示宿主要求）
// ---------------------------------------------------------------------------
const enginesDsh = pkg.engines?.dsh;
check(
  'engines.dsh 声明为非空字符串（SemVer 范围）',
  typeof enginesDsh === 'string' && enginesDsh.trim() !== '',
  enginesDsh === undefined ? '未声明（市场将显示「未声明宿主要求」）' : `实际：${JSON.stringify(enginesDsh)}`,
);
check(
  'engines.dsh 为收窄的 0.2.x 范围（^0.2.1-rc.5；0.3 未验证不虚报）',
  enginesDsh === '^0.2.1-rc.5',
  `实际：${JSON.stringify(enginesDsh)}`,
);

// ---------------------------------------------------------------------------
// 4. 依赖闭包无原生模块（安装形态审计；开发依赖除外）
// ---------------------------------------------------------------------------
const NATIVE_HINTS = /node-gyp|node-pre-gyp|prebuild-install|node-addon-api/i;
let nativeViolations = '';
try {
  const lockRaw = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  // 解析 packages:/snapshots: 段的条目块（2 空格缩进键 `name@version:`），
  // 从 pngjs/zod 沿块内 6 空格依赖键做传递闭包，只扫闭包块的构建链提示。
  const lines = lockRaw.split(/\r?\n/);
  const blocks = new Map();
  let section = null;
  let currentKey = null;
  let currentLines = [];
  const flush = () => {
    if (currentKey !== null) blocks.set(currentKey, currentLines.join('\n'));
    currentKey = null;
    currentLines = [];
  };
  for (const line of lines) {
    const sec = /^(importers|packages|snapshots):\s*$/.test(line);
    if (sec) {
      flush();
      section = line.replace(/:.*$/, '');
      continue;
    }
    if (section === null) continue;
    const entry = /^ {2}(\S+):$/.exec(line);
    if (entry) {
      flush();
      currentKey = entry[1];
      continue;
    }
    if (currentKey !== null) currentLines.push(line);
  }
  flush();
  const namesOf = (key) => key.slice(0, key.lastIndexOf('@'));
  const closure = new Set(['pngjs', 'zod']);
  const queue = ['pngjs', 'zod'];
  while (queue.length > 0) {
    const name = queue.shift();
    for (const [key, text] of blocks) {
      if (!key.startsWith(`${name}@`)) continue;
      for (const m of text.matchAll(/^ {6}([^ :\s]+):/gm)) {
        if (!closure.has(m[1])) {
          closure.add(m[1]);
          queue.push(m[1]);
        }
      }
    }
  }
  const violations = [];
  for (const [key, text] of blocks) {
    const name = namesOf(key);
    if (closure.has(name) && NATIVE_HINTS.test(text)) violations.push(name);
  }
  if (violations.length > 0) nativeViolations = `运行时依赖闭包含原生构建链：${[...new Set(violations)].join('、')}`;
} catch {
  // lock 文件缺失不视为违规（本地开发生成前）
}
check('pngjs/zod 依赖闭包无原生构建链', nativeViolations === '', nativeViolations);

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
