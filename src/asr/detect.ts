/**
 * 本地转写引擎探测。
 *
 * 目标：用户机器上「已经有什么」不该由用户自己填。探测顺序 =
 * 显式配置 → 插件托管目录 → PATH 上的已知实现。
 *
 * 探测只做文件存在性判断，不 spawn：设置页可以高频调用。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, isAbsolute, join } from 'node:path';
import {
  DEFAULT_MODEL_ID,
  LOCAL_ENGINES,
  managedPaths,
  modelPreset,
  type LocalEngineId,
  type ModelPresetId,
} from './catalog.js';

const EXE = process.platform === 'win32' ? '.exe' : '';

export interface LocalEngineSnapshot {
  engine: LocalEngineId;
  /** 可执行文件绝对路径（PATH 命中也为绝对路径）。 */
  exe: string | null;
  source: 'config' | 'managed' | 'path';
  modelPath: string | null;
  modelId: ModelPresetId;
  /** exe 与（若需要）模型都就绪。 */
  ready: boolean;
  /** 未就绪时的人话原因。 */
  reason: string | null;
}

export interface DetectInput {
  cacheDir: string;
  binPath?: string | undefined;
  modelPath?: string | undefined;
  modelId?: string | undefined;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 从可执行文件名反推引擎种类（用户显式填了路径的场景）。 */
export function inferEngine(exe: string): LocalEngineId {
  const base = basename(exe).toLowerCase().replace(/\.exe$/, '');
  if (base.includes('ctranslate2') || base.includes('faster-whisper')) return 'whisper_ctranslate2';
  if (base.includes('whisper-cli') || base === 'main') return 'whisper_cpp';
  return 'openai_whisper';
}

function findOnPath(names: readonly string[]): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir !== '');
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, `${name}${EXE}`);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

/** PATH 上定位可执行文件（ffmpeg 等）。 */
export function locateOnPath(names: readonly string[]): string | null {
  return findOnPath(names);
}

/** 托管模型目录里最新的 ggml 模型（用户可能下过别的型号）。 */
function pickManagedModel(modelDir: string): string | null {
  try {
    const files = readdirSync(modelDir)
      .filter((name) => name.startsWith('ggml-') && name.endsWith('.bin'))
      .map((name) => join(modelDir, name))
      .filter(isFile);
    if (files.length === 0) return null;
    files.sort((a, b) => (statSync(b).mtimeMs ?? 0) - (statSync(a).mtimeMs ?? 0));
    return files[0] ?? null;
  } catch {
    return null;
  }
}

export function detectLocalEngine(input: DetectInput): LocalEngineSnapshot {
  const modelId = (modelPreset(input.modelId).id ?? DEFAULT_MODEL_ID) as ModelPresetId;
  const managed = managedPaths(input.cacheDir);
  const preset = modelPreset(modelId);
  const managedModel = join(managed.modelDir, preset.file);

  const resolveModel = (engine: LocalEngineId): string | null => {
    if (input.modelPath !== undefined && input.modelPath !== '' && isFile(input.modelPath)) {
      return input.modelPath;
    }
    if (!LOCAL_ENGINES.find((entry) => entry.id === engine)?.needsModelFile) return null;
    if (isFile(managedModel)) return managedModel;
    return pickManagedModel(managed.modelDir);
  };

  const finish = (
    engine: LocalEngineId,
    exe: string,
    source: LocalEngineSnapshot['source'],
  ): LocalEngineSnapshot => {
    const needsModel = LOCAL_ENGINES.find((entry) => entry.id === engine)?.needsModelFile ?? false;
    const modelPath = resolveModel(engine);
    if (needsModel && modelPath === null) {
      return {
        engine,
        exe,
        source,
        modelPath: null,
        modelId,
        ready: false,
        reason: '找到转写程序，但还缺模型文件',
      };
    }
    return { engine, exe, source, modelPath, modelId, ready: true, reason: null };
  };

  if (input.binPath !== undefined && input.binPath !== '' && isAbsolute(input.binPath) && isFile(input.binPath)) {
    return finish(inferEngine(input.binPath), input.binPath, 'config');
  }

  if (isFile(managed.exe)) return finish('managed', managed.exe, 'managed');

  for (const entry of LOCAL_ENGINES) {
    if (entry.id === 'managed') continue;
    const found = findOnPath(entry.binNames);
    if (found !== null) return finish(entry.id, found, 'path');
  }

  return {
    engine: 'managed',
    exe: null,
    source: 'managed',
    modelPath: resolveModel('managed'),
    modelId,
    ready: false,
    reason: '尚未安装本地转写引擎',
  };
}

export function engineLabel(engine: LocalEngineId): string {
  return LOCAL_ENGINES.find((entry) => entry.id === engine)?.label ?? engine;
}
