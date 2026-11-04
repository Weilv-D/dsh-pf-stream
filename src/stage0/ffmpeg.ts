/**
 * ffmpeg / ffprobe 子进程封装。
 *
 * 约束（技术方案 §4.7 交互协议）：
 * - argv 数组直接传给 spawn，不经 shell 拼接；
 * - stdout / stderr 分别累计，超上限截断（防失控输出撑爆内存）；
 * - 超时与调用方 AbortSignal 协作终止进程，退出码非 0 时抛参数化错误；
 * - Windows 沙箱下管道捕获受限时优先 spawn stdio:'ignore' 形态（由调用方选择）。
 */

import { spawn } from 'node:child_process';
import { PfStreamError } from '../errors.js';

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 256 * 1024;

export interface ExecOptions {
  /** 毫秒；缺省不限时。 */
  timeoutMs?: number | undefined;
  /** 调用方取消信号。 */
  signal?: AbortSignal | undefined;
  /** stdout 编码：'utf8' 返回 string，'buffer' 返回 Buffer。 */
  encoding?: 'utf8' | 'buffer' | undefined;
}

export interface ExecResult {
  stdout: string | Buffer;
  stderr: string;
  exitCode: number;
}

export function execFile(file: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  const { timeoutMs, signal, encoding = 'utf8' } = options;

  return new Promise<ExecResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      reject(new PfStreamError('PFSTREAM_SPAWN_FAILED', `无法启动 ${file}：${(error as Error).message}`));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const tail = (chunks: Buffer[], bytes: number): string =>
      Buffer.concat(chunks.length > 8 ? chunks.slice(-8) : chunks).subarray(Math.max(0, bytes - 2048)).toString('utf8');

    const onKill = (code: string, message: string) => {
      if (settled) return;
      settled = true;
      reject(new PfStreamError(code, `${message}\nstderr 尾部：\n${tail(stderrChunks, stderrBytes)}`));
    };

    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_STDOUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_STDERR_BYTES) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    const timer =
      timeoutMs !== undefined
        ? setTimeout(() => {
            child.kill();
            onKill('PFSTREAM_EXEC_TIMEOUT', `${file} 执行超过 ${timeoutMs}ms`);
          }, timeoutMs)
        : undefined;

    const onAbort = () => {
      child.kill();
      onKill('PFSTREAM_EXEC_ABORT', `${file} 被调用方取消`);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new PfStreamError('PFSTREAM_SPAWN_FAILED', `无法启动 ${file}：${error.message}`));
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const stdout = encoding === 'buffer' ? Buffer.concat(stdoutChunks) : Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
      } else {
        reject(
          new PfStreamError('PFSTREAM_EXEC_NONZERO', `${file} 退出码 ${exitCode}\nstderr 尾部：\n${tail(stderrChunks, stderrBytes)}`),
        );
      }
    });
  });
}
