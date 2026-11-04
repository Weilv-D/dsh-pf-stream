/**
 * fixture 生成公共库：以命令行 + ffmpeg 版本联合哈希做幂等缓存。
 * 产物入 test/fixtures/media/，指纹缓存 test/fixtures/media/.fingerprint.json。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = join(HERE, '..', 'media');
const FINGERPRINT_PATH = join(MEDIA_DIR, '.fingerprint.json');

function ffmpegVersion() {
  const result = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? (result.stdout.split('\n')[0] ?? 'unknown') : 'unknown';
}

function loadFingerprints() {
  if (!existsSync(FINGERPRINT_PATH)) return {};
  try {
    return JSON.parse(readFileSync(FINGERPRINT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 幂等生成：输出文件存在且指纹（argv + ffmpeg 版本哈希）一致时跳过。
 * 返回输出文件绝对路径。
 */
export function ensureFixture(outputName, argv) {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const output = join(MEDIA_DIR, outputName);
  const key = createHash('sha256')
    .update(JSON.stringify([ffmpegVersion(), argv]))
    .digest('hex')
    .slice(0, 16);
  const fingerprints = loadFingerprints();
  if (existsSync(output) && fingerprints[outputName] === key) return output;

  const run = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv, output], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (run.status !== 0) {
    const detail = run.error ? run.error.message : run.stderr;
    throw new Error(`fixture ${outputName} 生成失败（exit ${run.status}）：${detail}`);
  }
  if (!existsSync(output)) {
    throw new Error(`fixture ${outputName} 生成失败：输出文件不存在（ffmpeg 可能把输出当输入）：${run.stderr}`);
  }
  fingerprints[outputName] = key;
  writeFileSync(FINGERPRINT_PATH, JSON.stringify(fingerprints, null, 2));
  return output;
}
