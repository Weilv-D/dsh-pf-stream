/**
 * 用例 22：确定性检视通道的包数/预算截断提示行。
 *
 * 此前该通道只在模型显式传 max_packets 时才有包数约束，缺省可产出远超宿主
 * 20 图上限的包数，而回传图像按 maxImagesPerCall 截尾保留——靠前的包无画布
 * 且截断事实不可见（静默盲区）。修复后：intent.max_packets ?? maxPackets
 * 钳制包数，预算/包数停止以提示行如实告知（与 pf_stream 通道同语义）。
 */

import { describe, expect, it } from 'vitest';
import { runDeterministicInspection } from '../../src/stage3/deterministicRouter.js';
import { probeVideo } from '../../src/stage0/probe.js';
import { resolveBinPaths } from '../../src/utils/ffmpegBin.js';

const bins = resolveBinPaths();

describe('用例 22：确定性通道包数/预算截断提示', () => {
  it('包数上限停止：包数钳制到上限，尾部追加截断提示行', async () => {
    const probe = await probeVideo('test/fixtures/media/case04_plain.mp4', { ffprobePath: bins.ffprobe });
    // 3s fixture × frame_count=128 → 128 目标 → 26 组 → 钳到 20 包
    const capped = await runDeterministicInspection(
      'test/fixtures/media/case04_plain.mp4',
      probe,
      { action: 'uniform', frame_count: 128 },
      {
        ffmpegPath: bins.ffmpeg,
        renderVisualId: false,
        packetIdStart: 1,
        globalIdStart: 1,
        appliedIntentId: 'intent_1',
        maxPackets: 20,
      },
    );
    expect(capped.packets).toHaveLength(20);
    // 20 条 1:1 时间线 + 1 条截断提示
    expect(capped.hintLines).toHaveLength(21);
    expect(capped.hintLines[capped.hintLines.length - 1]).toContain('包数上限');
    // 时间轴头部采样保全（截断的是尾部）
    expect(capped.sampledPtsMs.length).toBeGreaterThanOrEqual(100);
  });

  it('未触顶不误加提示行（hintLines 与 packets 保持 1:1）', async () => {
    const probe = await probeVideo('test/fixtures/media/case04_plain.mp4', { ffprobePath: bins.ffprobe });
    const plain = await runDeterministicInspection(
      'test/fixtures/media/case04_plain.mp4',
      probe,
      { action: 'uniform', frame_count: 40 },
      {
        ffmpegPath: bins.ffmpeg,
        renderVisualId: false,
        packetIdStart: 1,
        globalIdStart: 1,
        appliedIntentId: 'intent_1',
        maxPackets: 20,
      },
    );
    expect(plain.packets.length).toBeGreaterThan(0);
    expect(plain.packets.length).toBeLessThan(20);
    expect(plain.hintLines).toHaveLength(plain.packets.length);
    expect(plain.hintLines.join('\n')).not.toContain('包数上限');
  });

  it('预算停止同样有提示行；首包即超限时返回空结果 + 提示', async () => {
    const probe = await probeVideo('test/fixtures/media/case04_plain.mp4', { ffprobePath: bins.ffprobe });
    // balanced uniform 首组 FORM_1（530）；预算 274 → 首包即超限
    const tight = await runDeterministicInspection(
      'test/fixtures/media/case04_plain.mp4',
      probe,
      { action: 'uniform', frame_count: 40, max_tokens_budget: 274 },
      {
        ffmpegPath: bins.ffmpeg,
        renderVisualId: false,
        packetIdStart: 1,
        globalIdStart: 1,
        appliedIntentId: 'intent_1',
        maxPackets: 20,
      },
    );
    expect(tight.packets).toHaveLength(0);
    expect(tight.hintLines).toHaveLength(1);
    expect(tight.hintLines[0]).toContain('max_tokens_budget');
  });

  it('intent.max_packets 优先于缺省上限，停止同样有提示行', async () => {
    const probe = await probeVideo('test/fixtures/media/case04_plain.mp4', { ffprobePath: bins.ffprobe });
    const capped = await runDeterministicInspection(
      'test/fixtures/media/case04_plain.mp4',
      probe,
      { action: 'uniform', frame_count: 128, max_packets: 3 },
      {
        ffmpegPath: bins.ffmpeg,
        renderVisualId: false,
        packetIdStart: 1,
        globalIdStart: 1,
        appliedIntentId: 'intent_1',
        maxPackets: 20,
      },
    );
    expect(capped.packets).toHaveLength(3);
    expect(capped.hintLines).toHaveLength(4);
    expect(capped.hintLines[capped.hintLines.length - 1]).toContain('包数上限');
  });
});
