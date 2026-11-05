import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { transcribeLocalCli } from '../../../src/audio/asrProviders.js';
import type { AsrSettings } from '../../../src/audio/types.js';

const cli = fileURLToPath(new URL('./fixtures/fake-asr-cli.mjs', import.meta.url));

function settings(args: string[] | null): AsrSettings {
  return {
    provider: 'local_cli',
    baseUrl: null,
    model: process.execPath,
    apiKey: null,
    language: null,
    args,
    timeoutMs: 30000,
    maxConcurrency: 1,
  };
}

const chunk = { startMs: 1000, endMs: 4000, bytes: new Uint8Array([1, 2, 3]) };

describe('local_cli 令牌与产物回读', () => {
  it('{dir} 令牌：优先读产物文件，忽略 stdout 进度杂讯', async () => {
    const out = await transcribeLocalCli(chunk, { settings: settings([cli, 'dir-srt', '--dir', '{dir}']), signal: undefined });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('你好世界');
    expect(out[0]?.startMs).toBe(500);
    expect(out[0]?.endMs).toBe(2000);
  });

  it('{out} 令牌：读 JSON 产物并取段级时间戳', async () => {
    const out = await transcribeLocalCli(chunk, { settings: settings([cli, 'out-json', '--out', '{out}']), signal: undefined });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('令牌输出');
    expect(out[0]?.startMs).toBe(250);
    expect(out[0]?.endMs).toBe(1500);
  });

  it('无令牌：音频路径追加末尾，stdout 的 SRT 直接解析', async () => {
    const out = await transcribeLocalCli(chunk, { settings: settings([cli, 'stdout']), signal: undefined });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('标准输出台词');
    expect(out[0]?.startMs).toBe(1000);
    expect(out[0]?.endMs).toBe(2500);
  });

  it('{audio} 令牌展开为实际音频文件', async () => {
    const out = await transcribeLocalCli(
      { startMs: 0, endMs: 1000, bytes: new Uint8Array([9, 8, 7, 6, 5]) },
      { settings: settings([cli, 'audio-bytes', '--audio', '{audio}']), signal: undefined },
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe('bytes=5');
  });
});
