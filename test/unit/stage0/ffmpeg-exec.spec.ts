/**
 * execFile 封装的取消语义（P2-3 修复回归）：
 * 已中止的 signal 不再触发 abort 事件——必须显式预检拒绝，
 * 否则「调用前已取消」的子进程照常跑完并正常返回（Node 内建 execFile 语义）。
 */
import { describe, expect, it } from 'vitest';
import { execFile } from '../../../src/stage0/ffmpeg.js';

describe('execFile 取消语义', () => {
  it('已中止 signal → 立即拒绝 PFSTREAM_EXEC_ABORT，不 spawn 子进程', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      execFile('ffmpeg', ['-version'], { signal: controller.signal, encoding: 'utf8' }),
    ).rejects.toMatchObject({ code: 'PFSTREAM_EXEC_ABORT' });
  });

  it('正常路径不受预检影响（退出码 0 → resolve）', async () => {
    const { stdout } = await execFile('ffmpeg', ['-version'], { encoding: 'utf8' });
    expect(stdout).toContain('ffmpeg version');
  }, 30_000);
});
