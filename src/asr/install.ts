/**
 * 本地转写资源安装器：下载 → 校验 → 解压 → 落位。
 *
 * 约束：
 * - 不引入任何运行时依赖（包只允许 pngjs）；用 Node 内置 fetch/stream/child_process。
 * - 下载可取消、可断点续传；进度对设置页可见。
 * - 失败必须给出可行动的原因（网络/磁盘/校验），不吞异常。
 */

import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  managedPaths,
  modelDownloadUrls,
  modelPreset,
  whisperCppUrls,
  type ModelPresetId,
} from './catalog.js';

export type InstallTarget = 'model' | 'engine' | 'all';
export type InstallPhase =
  | 'idle'
  | 'preparing'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface InstallJob {
  id: string;
  target: InstallTarget;
  phase: InstallPhase;
  /** 当前资源的人类可读名（引擎包 / 模型文件）。 */
  resource: string;
  received: number;
  total: number | null;
  message: string | null;
  startedAt: number;
  finishedAt: number | null;
  result: { exe?: string; modelPath?: string; integrity?: 'sha256' | 'size' } | null;
}

export interface InstallerOptions {
  cacheDir: string;
  modelId: string;
  /** 自定义下载基地址（镜像/离线），缺省用官方源。 */
  logger?: (line: string) => void;
  /** 任务结束（成功/失败/取消）时回调，用于让探测缓存失效。 */
  onFinished?: (() => void) | undefined;
}

const PART_SUFFIX = '.part';

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

interface DownloadResult {
  url: string;
  bytes: number;
}

/**
 * 逐 URL 尝试下载到 dest；dest.part 保留已下载字节，支持 Range 续传。
 * 404/网络错误自动换下一个源；用户取消立即抛出 AbortError。
 */
async function downloadFirst(
  urls: readonly string[],
  dest: string,
  onProgress: (received: number, total: number | null) => void,
  signal: AbortSignal,
): Promise<DownloadResult> {
  const part = `${dest}${PART_SUFFIX}`;
  const failures: string[] = [];
  for (const url of urls) {
    let start = fileSize(part);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'follow',
        headers: start > 0 ? { range: `bytes=${start}-` } : {},
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${url}: ${(error as Error).message}`);
      continue;
    }
    if (response.status === 416) {
      // 续传位置已到文件末尾：视为完成。
      return { url, bytes: start };
    }
    if (!response.ok) {
      failures.push(`${url}: HTTP ${response.status}`);
      continue;
    }
    if (start > 0 && response.status !== 206) start = 0;
    const lengthHeader = response.headers.get('content-length');
    const incoming = lengthHeader === null ? 0 : Number(lengthHeader) || 0;
    const total = start + incoming > 0 ? start + incoming : null;
    if (response.body === null) {
      failures.push(`${url}: 响应没有内容`);
      continue;
    }
    mkdirSync(join(dest, '..'), { recursive: true });
    const sink = createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
    let received = start;
    const source = Readable.fromWeb(
      response.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
    );
    source.on('data', (chunk: Buffer) => {
      received += chunk.length;
      onProgress(received, total);
    });
    try {
      await pipeline(source, sink, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${url}: ${(error as Error).message}`);
      continue;
    }
    if (total !== null && received < total) {
      failures.push(`${url}: 连接提前结束（${received}/${total} 字节）`);
      continue;
    }
    return { url, bytes: received };
  }
  throw new Error(`下载失败，已尝试 ${urls.length} 个源：\n${failures.join('\n')}`);
}

function run(command: string, args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true, signal });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${String(code)}`));
    });
  });
}

function findExecutable(dir: string, names: readonly string[], depth = 3): string | null {
  if (depth < 0) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const direct = join(dir, name);
    if (existsSync(direct) && statSync(direct).isFile()) return direct;
  }
  for (const entry of entries) {
    const child = join(dir, entry);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    const found = findExecutable(child, names, depth - 1);
    if (found !== null) return found;
  }
  return null;
}

async function extractZip(archive: string, dest: string, signal: AbortSignal): Promise<void> {
  mkdirSync(dest, { recursive: true });
  try {
    await run('tar', ['-xf', archive, '-C', dest], signal);
    return;
  } catch (error) {
    if (signal.aborted) throw error;
    if (process.platform !== 'win32') throw error;
  }
  // Windows 老版本没有 bsdtar：退回 PowerShell。
  await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dest}' -Force`],
    signal,
  );
}

let jobSeq = 0;

/**
 * 单任务安装器：同一时刻只允许一个下载任务，避免抢占带宽与磁盘。
 * 状态保存在内存，页面轮询；宿主重启后重置（已落盘的文件仍有效）。
 */
export class LocalAsrInstaller {
  private job: InstallJob | null = null;
  private controller: AbortController | null = null;

  constructor(private options: InstallerOptions) {}

  /** 配置变更后同步模型档位与缓存目录（下一次安装生效，进行中的任务不打断）。 */
  update(patch: Partial<Pick<InstallerOptions, 'cacheDir' | 'modelId'>>): void {
    this.options = { ...this.options, ...patch };
  }

  current(): InstallJob | null {
    return this.job;
  }

  private patch(patch: Partial<InstallJob>): void {
    if (this.job === null) return;
    this.job = { ...this.job, ...patch };
  }

  private progress(received: number, total: number | null): void {
    this.patch({ received, total });
  }

  cancel(): void {
    if (this.job === null) return;
    this.patch({ phase: 'cancelled', message: '已取消', finishedAt: Date.now() });
    this.controller?.abort();
    this.controller = null;
  }

  /** 启动安装；已有进行中的任务时直接返回该任务。 */
  start(target: InstallTarget): InstallJob {
    if (this.job !== null && (this.job.phase === 'downloading' || this.job.phase === 'verifying' || this.job.phase === 'extracting' || this.job.phase === 'preparing')) {
      return this.job;
    }
    const job: InstallJob = {
      id: `install-${++jobSeq}`,
      target,
      phase: 'preparing',
      resource: '',
      received: 0,
      total: null,
      message: null,
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
    };
    this.job = job;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    void this.run(job, signal)
      .catch((error: unknown) => {
        if (signal.aborted) {
          this.patch({ phase: 'cancelled', finishedAt: Date.now(), message: '已取消' });
          return;
        }
        this.patch({
          phase: 'failed',
          finishedAt: Date.now(),
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.options.onFinished?.();
      });
    return job;
  }

  private async run(job: InstallJob, signal: AbortSignal): Promise<void> {
    const { cacheDir } = this.options;
    const preset = modelPreset(this.options.modelId);
    const managed = managedPaths(cacheDir);
    const result: NonNullable<InstallJob['result']> = {};
    mkdirSync(managed.modelDir, { recursive: true });
    mkdirSync(managed.binDir, { recursive: true });

    if (job.target === 'engine' || job.target === 'all') {
      if (!existsSync(managed.exe)) {
        this.patch({ resource: 'whisper.cpp 引擎', phase: 'downloading', received: 0, total: null });
        const archive = join(managed.binDir, 'whisper-cpp.zip');
        const partialArchive = `${archive}${PART_SUFFIX}`;
        await downloadFirst(whisperCppUrls(), archive, (r, t) => this.progress(r, t), signal);
        // downloadFirst 只写 .part，改名由调用方负责；漏了这步解压会找不到文件。
        if (existsSync(partialArchive)) renameSync(partialArchive, archive);
        this.patch({ resource: 'whisper.cpp 引擎', phase: 'extracting' });
        await extractZip(archive, managed.binDir, signal);
        rmSync(archive, { force: true });
        const exe = findExecutable(managed.binDir, ['whisper-cli.exe', 'whisper-cli', 'main.exe']);
        if (exe === null) {
          throw new Error('下载的压缩包里没有找到 whisper-cli 可执行文件');
        }
        // 官方 Windows 包把 exe 与 DLL 放在 Release/ 子目录：整体搬到 binDir，
        // 否则只挪 exe 会丢掉 ggml.dll / whisper.dll，一运行就报错。
        const exeDir = dirname(exe);
        if (exeDir !== managed.binDir) {
          for (const name of readdirSync(exeDir)) {
            const from = join(exeDir, name);
            try {
              if (!statSync(from).isFile()) continue;
            } catch {
              continue;
            }
            const to = join(managed.binDir, name);
            rmSync(to, { force: true });
            renameSync(from, to);
          }
          rmSync(exeDir, { recursive: true, force: true });
        }
        if (!existsSync(managed.exe)) {
          const located = findExecutable(managed.binDir, ['whisper-cli.exe', 'whisper-cli', 'main.exe']);
          if (located !== null && located !== managed.exe) renameSync(located, managed.exe);
        }
      }
    }

    if (job.target === 'model' || job.target === 'all') {
      const modelPath = join(managed.modelDir, preset.file);
      if (!existsSync(modelPath)) {
        this.patch({ resource: preset.label, phase: 'downloading', received: 0, total: null });
        const partial = `${modelPath}${PART_SUFFIX}`;
        const done = await downloadFirst(modelDownloadUrls(preset), modelPath, (r, t) => this.progress(r, t), signal);
        this.patch({ phase: 'verifying', message: '校验文件…' });
        const bytes = fileSize(partial);
        if (bytes < 1024 * 1024) throw new Error(`模型文件不完整（${bytes} 字节）`);
        renameSync(partial, modelPath);
        result.modelPath = modelPath;
        result.integrity = 'size';
        this.options.logger?.(`model downloaded from ${done.url} (${bytes} bytes)`);
      }
      if (!('modelPath' in result)) {
        result.modelPath = modelPath;
        result.integrity = 'size';
      }
    }

    if (existsSync(managed.exe)) result.exe = managed.exe;
    this.patch({
      phase: 'done',
      finishedAt: Date.now(),
      resource: '',
      message: job.target === 'model' ? '模型已就绪' : '本地转写已就绪',
      result,
    });
  }
}

/** 计算目录占用（用于设置页显示缓存体积）。 */
export function directoryBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) total += directoryBytes(path);
      else if (entry.isFile()) total += fileSize(path);
    }
  } catch {
    return total;
  }
  return total;
}
