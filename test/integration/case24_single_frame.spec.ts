/**
 * 用例 24：单帧视频（末帧 PTS=0）的 pf_stream 通道可见性（P2-4 修复回归）。
 *
 * 修复前：w0 >= lastPtsMs 门在 lastPtsMs=0 时 0>=0 直接判 end_of_stream，
 * 唯一的帧永不被解码（timestamps 通道钳到 [0] 可检视，两通道口径不一）。
 * 修复后：首访放行一次解码，游标 +1ms 越过虚拟流末（不无限重放），并给
 * 可行动提示行指引改用 timestamps 检视唯一帧（单帧不足以组包）。
 */
import { describe, expect, it } from 'vitest';
import { runStreamCallFixture, fixturePath } from './helpers.js';
import { runDeterministicInspection } from '../../src/stage3/deterministicRouter.js';
import { probeVideo } from '../../src/stage0/probe.js';

describe('case24: 单帧视频可见性', () => {
  it('pf_stream 首访如实消费单帧并给可行动提示，后续调用不重放', async () => {
    const c1 = await runStreamCallFixture('case24_single_frame.mp4', 'case24', {});
    expect(c1.telemetry.stopReason).toBe('end_of_stream');
    expect(c1.hintLines.join('\n')).toContain('timestamps_ms=[0]');
    const c2 = await runStreamCallFixture('case24_single_frame.mp4', 'case24', {});
    expect(c2.packets.length).toBe(0);
    expect(c2.telemetry.stopReason).toBe('end_of_stream');
  }, 120_000);

  it('timestamps 通道对同一视频照常可检视（两通道口径一致）', async () => {
    const path = fixturePath('case24_single_frame.mp4');
    const probe = await probeVideo(path, { ffprobePath: 'ffprobe' });
    const result = await runDeterministicInspection(
      path,
      probe,
      { action: 'timestamps', timestamps_ms: [0] },
      {
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        renderVisualId: false,
        packetIdStart: 1,
        globalIdStart: 1,
        appliedIntentId: 'intent_1',
        maxPackets: 20,
        maxFrames: 128,
      },
    );
    expect(result.packets.length).toBe(1);
  }, 120_000);
});

