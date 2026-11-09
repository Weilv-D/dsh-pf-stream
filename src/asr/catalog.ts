/**
 * ASR 目录表：面向用户的「服务商 / 本地引擎」预设。
 *
 * 设计意图（0.3.0）：
 * - 用户只回答三个问题：用不用云端、选哪家、填 Key；其余参数由预设给出。
 * - 预设是纯数据，可被设置页展示、被宿主侧解析；不含密钥。
 * - 协议只有两种（openai_verbose / openai_basic），服务商差异折叠为 baseUrl+model。
 */

import { join } from 'node:path';

export type CloudPresetId = 'openai' | 'groq' | 'custom';

export interface CloudPreset {
  id: CloudPresetId;
  /** 展示名（设置页按 locale 覆盖文案，这里给兜底中文）。 */
  label: string;
  baseUrl: string;
  model: string;
  protocol: 'openai_verbose' | 'openai_basic';
  /** 凭据 ref；每个服务商独立，切换不互相覆盖。 */
  keyRef: string;
  /** 用户获取 Key 的页面。 */
  keyUrl: string;
  /** 是否允许用户改写 baseUrl / model（自定义端点）。 */
  editable: boolean;
}

export const CLOUD_PRESETS: readonly CloudPreset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    model: 'whisper-1',
    protocol: 'openai_verbose',
    keyRef: 'DSH_ASR_KEY_OPENAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    editable: false,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai',
    model: 'whisper-large-v3-turbo',
    protocol: 'openai_verbose',
    keyRef: 'DSH_ASR_KEY_GROQ',
    keyUrl: 'https://console.groq.com/keys',
    editable: false,
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容端点',
    baseUrl: '',
    model: '',
    protocol: 'openai_verbose',
    keyRef: 'DSH_ASR_KEY_CUSTOM',
    keyUrl: '',
    editable: true,
  },
];

export function cloudPreset(id: string | null | undefined): CloudPreset {
  const found = CLOUD_PRESETS.find((preset) => preset.id === id);
  return found ?? CLOUD_PRESETS[0]!;
}

export type LocalEngineId = 'managed' | 'whisper_cpp' | 'whisper_ctranslate2' | 'openai_whisper';

export interface LocalEngineInfo {
  id: LocalEngineId;
  label: string;
  /** PATH 上的候选可执行文件名（不含后缀）。 */
  binNames: readonly string[];
  /** 是否需要 ggml 模型文件（whisper.cpp 系）；Python 封装自带模型管理。 */
  needsModelFile: boolean;
}

export const LOCAL_ENGINES: readonly LocalEngineInfo[] = [
  { id: 'managed', label: '内置 whisper.cpp（插件托管）', binNames: [], needsModelFile: true },
  { id: 'whisper_cpp', label: 'whisper.cpp（已安装）', binNames: ['whisper-cli', 'main'], needsModelFile: true },
  {
    id: 'whisper_ctranslate2',
    label: 'faster-whisper / whisper-ctranslate2',
    binNames: ['whisper-ctranslate2', 'faster-whisper'],
    needsModelFile: false,
  },
  { id: 'openai_whisper', label: 'openai-whisper（Python）', binNames: ['whisper'], needsModelFile: false },
];

export type ModelPresetId = 'base-q5_1' | 'small-q5_1' | 'medium-q5_0';

export interface ModelPreset {
  id: ModelPresetId;
  label: string;
  file: string;
  /**
   * 官方下载路径（Hugging Face LFS）。钉扎到 whisper.cpp v1.7.6 对应 commit
   * （`/resolve/<commit>/`，内容不可变）——`/resolve/main/` 跟随可变分支指针，
   * 上游替换内容时下载物会静默漂移。
   */
  path: string;
  /** LFS 精确字节数：落位校验（≠ 即重下自愈）与下载前提示共用。 */
  bytes: number;
  /** LFS sha256：落位完整性校验。镜像源同样过此校验——供应链上不信任镜像。 */
  sha256: string;
  /** 建议磁盘占用（字节，用于下载前提示）。 */
  approxBytes: number;
}

/**
 * Hugging Face 模型仓库 `ggerganov/whisper.cpp` 的 commit 锚点（模型 LFS 路径
 * 钉扎用）。注意：这是 HF 仓库自己的 commit（2024-10 后未变），不是 GitHub
 * whisper.cpp 的 tag commit——两者是不同仓库（复核时实证：GitHub tag sha 在
 * HF 上 404）。引擎 zip 仍走 GitHub Releases 的 v1.7.6 tag（那才是 GitHub 侧）。
 */
export const MODEL_REPO_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1';

export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'base-q5_1',
    label: '快速（base，约 60MB）',
    file: 'ggml-base-q5_1.bin',
    path: `ggerganov/whisper.cpp/resolve/${MODEL_REPO_COMMIT}/ggml-base-q5_1.bin`,
    bytes: 59707625,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
    approxBytes: 60 * 1024 * 1024,
  },
  {
    id: 'small-q5_1',
    label: '推荐（small，约 190MB）',
    file: 'ggml-small-q5_1.bin',
    path: `ggerganov/whisper.cpp/resolve/${MODEL_REPO_COMMIT}/ggml-small-q5_1.bin`,
    bytes: 190085487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    approxBytes: 190 * 1024 * 1024,
  },
  {
    id: 'medium-q5_0',
    label: '更准（medium，约 540MB）',
    file: 'ggml-medium-q5_0.bin',
    path: `ggerganov/whisper.cpp/resolve/${MODEL_REPO_COMMIT}/ggml-medium-q5_0.bin`,
    bytes: 539212467,
    sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
    approxBytes: 540 * 1024 * 1024,
  },
];

export const DEFAULT_MODEL_ID: ModelPresetId = 'small-q5_1';

export function modelPreset(id: string | null | undefined): ModelPreset {
  const found = MODEL_PRESETS.find((preset) => preset.id === id);
  if (found !== undefined) return found;
  return MODEL_PRESETS.find((preset) => preset.id === DEFAULT_MODEL_ID)!;
}

/** Hugging Face 官方源 + 国内镜像；顺序即尝试顺序。 */
export function modelDownloadUrls(preset: ModelPreset): string[] {
  const override = process.env.DSH_PF_STREAM_MODEL_BASE?.trim();
  const bases = override !== undefined && override !== '' ? [override] : [
    'https://huggingface.co',
    'https://hf-mirror.com',
  ];
  return bases.map((base) => `${base.replace(/\/+$/, '')}/${preset.path}`);
}

/** whisper.cpp 官方 Windows 预编译包（x64）；文件名随发行变化，候选按序尝试。 */
export const WHISPER_CPP_VERSION = 'v1.7.6';

export function whisperCppUrls(): string[] {
  const override = process.env.DSH_PF_STREAM_WHISPER_URL?.trim();
  if (override !== undefined && override !== '') return [override];
  const base = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_VERSION}`;
  return [`${base}/whisper-bin-x64.zip`];
}

/** 托管目录：<cacheDir>/asr/{bin,models}。 */
export function managedPaths(cacheDir: string): { binDir: string; modelDir: string; exe: string } {
  const exe = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const binDir = join(cacheDir, 'asr', 'bin');
  return { binDir, modelDir: join(cacheDir, 'asr', 'models'), exe: join(binDir, exe) };
}

export interface LocalArgsContext {
  audioToken?: string;
  dirToken?: string;
  outBaseToken?: string;
  modelPath: string | null;
  modelName: string;
  language: string | null;
  threads: number;
}

/**
 * 内置参数模板。用户不再手写 args：
 * - whisper.cpp 系：`-m <model> -f <audio> -osrt -of <outbase> -l <lang> -t <threads>`
 * - Python 封装：调用各自 CLI 的 srt 输出参数，音频作位置参数。
 */
export function buildLocalArgs(engine: LocalEngineId, ctx: LocalArgsContext): string[] {
  const lang = ctx.language ?? 'auto';
  const threads = Math.max(1, Math.min(16, Math.trunc(ctx.threads) || 4));
  const audio = ctx.audioToken ?? '{audio}';
  const dir = ctx.dirToken ?? '{dir}';
  const outBase = ctx.outBaseToken ?? '{outbase}';
  switch (engine) {
    case 'managed':
    case 'whisper_cpp':
      return [
        '-m',
        ctx.modelPath ?? '',
        '-f',
        audio,
        '-osrt',
        '-of',
        outBase,
        '-l',
        lang,
        '-t',
        String(threads),
      ];
    case 'whisper_ctranslate2':
      return [
        '--model',
        ctx.modelName,
        // Python 系 CLI 的 --language 不接受 'auto' 字面量：省略即自动检测
        ...(lang === 'auto' ? [] : ['--language', lang]),
        '--task',
        'transcribe',
        '--output_format',
        'srt',
        '--output_dir',
        dir,
        '--device',
        'cpu',
        '--compute_type',
        'int8',
      ];
    case 'openai_whisper':
      return [
        '--model',
        ctx.modelName,
        ...(lang === 'auto' ? [] : ['--language', lang]),
        '--output_format',
        'srt',
        '--output_dir',
        dir,
      ];
  }
}
