import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MODEL_ID,
  buildLocalArgs,
  managedPaths,
  modelDownloadUrls,
  modelPreset,
  whisperCppUrls,
} from '../../../src/asr/catalog.js';
import { detectLocalEngine, inferEngine } from '../../../src/asr/detect.js';

const MODEL = '/models/ggml-small-q5_1.bin';

describe('本地引擎参数模板', () => {
  it('whisper.cpp 系：内置模型、SRT、输出基名与线程数', () => {
    const args = buildLocalArgs('whisper_cpp', {
      modelPath: MODEL,
      modelName: 'small',
      language: 'zh',
      threads: 0,
    });
    expect(args).toEqual(['-m', MODEL, '-f', '{audio}', '-osrt', '-of', '{outbase}', '-l', 'zh', '-t', '4']);
  });

  it('托管引擎与 whisper.cpp 同模板', () => {
    const managed = buildLocalArgs('managed', { modelPath: MODEL, modelName: 'small', language: null, threads: 6 });
    expect(managed).toEqual(['-m', MODEL, '-f', '{audio}', '-osrt', '-of', '{outbase}', '-l', 'auto', '-t', '6']);
  });

  it('whisper-ctranslate2：CPU + int8，按目录取产物', () => {
    const args = buildLocalArgs('whisper_ctranslate2', {
      modelPath: null,
      modelName: 'small',
      language: 'zh',
      threads: 4,
    });
    expect(args).toContain('--device');
    expect(args[args.indexOf('--device') + 1]).toBe('cpu');
    expect(args).toContain('--compute_type');
    expect(args[args.indexOf('--compute_type') + 1]).toBe('int8');
    expect(args).toContain('{dir}');
  });

  it('openai-whisper：按目录取 SRT', () => {
    const args = buildLocalArgs('openai_whisper', {
      modelPath: null,
      modelName: 'small',
      language: 'zh',
      threads: 4,
    });
    expect(args).toEqual(['--model', 'small', '--language', 'zh', '--output_format', 'srt', '--output_dir', '{dir}']);
  });

  it('线程数夹在 1..16', () => {
    expect(buildLocalArgs('whisper_cpp', { modelPath: MODEL, modelName: 'small', language: 'zh', threads: 99 })).toContain('16');
    expect(buildLocalArgs('whisper_cpp', { modelPath: MODEL, modelName: 'small', language: 'zh', threads: -3 })).toContain('1');
  });
});

describe('模型清单与下载源', () => {
  it('默认模型为 small 量化版', () => {
    expect(DEFAULT_MODEL_ID).toBe('small-q5_1');
    expect(modelPreset(DEFAULT_MODEL_ID).file).toBe('ggml-small-q5_1.bin');
  });

  it('官方源 + 镜像源，可被环境变量覆盖', () => {
    const preset = modelPreset('small-q5_1');
    const urls = modelDownloadUrls(preset);
    expect(urls[0]).toContain('huggingface.co');
    expect(urls[1]).toContain('hf-mirror.com');

    const previous = process.env.DSH_PF_STREAM_MODEL_BASE;
    process.env.DSH_PF_STREAM_MODEL_BASE = 'https://mirror.example.com';
    try {
      expect(modelDownloadUrls(preset)).toEqual([`https://mirror.example.com/${preset.path}`]);
    } finally {
      if (previous === undefined) delete process.env.DSH_PF_STREAM_MODEL_BASE;
      else process.env.DSH_PF_STREAM_MODEL_BASE = previous;
    }
  });

  it('whisper.cpp 压缩包地址可被环境变量覆盖', () => {
    const previous = process.env.DSH_PF_STREAM_WHISPER_URL;
    process.env.DSH_PF_STREAM_WHISPER_URL = 'https://example.com/whisper.zip';
    try {
      expect(whisperCppUrls()).toEqual(['https://example.com/whisper.zip']);
    } finally {
      if (previous === undefined) delete process.env.DSH_PF_STREAM_WHISPER_URL;
      else process.env.DSH_PF_STREAM_WHISPER_URL = previous;
    }
  });
});

describe('本地引擎探测', () => {
  it('从可执行文件名反推引擎', () => {
    expect(inferEngine('C:/x/whisper-cli.exe')).toBe('whisper_cpp');
    expect(inferEngine('C:/x/main.exe')).toBe('whisper_cpp');
    expect(inferEngine('C:/x/whisper-ctranslate2.exe')).toBe('whisper_ctranslate2');
    expect(inferEngine('C:/x/whisper.exe')).toBe('openai_whisper');
  });

  it('显式 binPath 指向 whisper.cpp 但没模型 → 未就绪且原因明确', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pf-detect-'));
    try {
      const exe = path.join(dir, 'whisper-cli.exe');
      await writeFile(exe, 'stub');
      const found = detectLocalEngine({ cacheDir: path.join(dir, 'cache'), binPath: exe });
      expect(found.engine).toBe('whisper_cpp');
      expect(found.source).toBe('config');
      expect(found.exe).toBe(exe);
      expect(found.ready).toBe(false);
      expect(found.reason).toBe('找到转写程序，但还缺模型文件');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('显式 binPath 指向 ctranslate2 → 无需模型文件即就绪', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pf-detect-'));
    try {
      const exe = path.join(dir, 'whisper-ctranslate2.exe');
      await writeFile(exe, 'stub');
      const found = detectLocalEngine({ cacheDir: path.join(dir, 'cache'), binPath: exe });
      expect(found.engine).toBe('whisper_ctranslate2');
      expect(found.ready).toBe(true);
      expect(found.modelPath).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('托管目录装好 exe + 模型后可直接就绪', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pf-detect-'));
    try {
      const managed = managedPaths(dir);
      await mkdir(managed.binDir, { recursive: true });
      await mkdir(managed.modelDir, { recursive: true });
      await writeFile(managed.exe, 'stub');
      await writeFile(path.join(managed.modelDir, modelPreset('small-q5_1').file), 'stub');
      const found = detectLocalEngine({ cacheDir: dir });
      expect(found.source).toBe('managed');
      expect(found.ready).toBe(true);
      expect(found.modelPath).toBe(path.join(managed.modelDir, 'ggml-small-q5_1.bin'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('空机器 → 未安装', () => {
    const found = detectLocalEngine({ cacheDir: path.join(tmpdir(), 'pf-detect-nonexistent') });
    expect(found.exe).toBeNull();
    expect(found.ready).toBe(false);
    expect(found.reason).toBe('尚未安装本地转写引擎');
  });
});
