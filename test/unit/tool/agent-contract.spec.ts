/**
 * 面向 agent 的契约回归：工具描述、输出 schema 与 renderContent 必须与
 * 参数 schema、实际返回结构保持一致，避免模型按错误前提调用工具。
 */

import { describe, expect, it } from 'vitest';
import { TOOL_DESCRIPTION, toolOutputSchema } from '../../../lib/tool/schema.js';
import { renderContent } from '../../../src/index.js';

function image(attachmentId: string) {
  return { attachmentId, mediaType: 'image/png', bytes: 4, width: 2, height: 2 };
}

describe('TOOL_DESCRIPTION', () => {
  it('probe 只用于元数据/字幕，视觉问题直接走 pf_stream', () => {
    expect(TOOL_DESCRIPTION).not.toContain('call action="probe" first');
    expect(TOOL_DESCRIPTION).toContain('use action="probe" only for metadata or subtitles');
    expect(TOOL_DESCRIPTION).toContain('call action="pf_stream"');
    expect(TOOL_DESCRIPTION).toContain('it probes internally');
  });

  it('参数位置说明与 schema 一致：标准字段两处、legacy 仅顶层', () => {
    expect(TOOL_DESCRIPTION).toContain('Standard action fields');
    expect(TOOL_DESCRIPTION).toContain('values inside intent take precedence');
    expect(TOOL_DESCRIPTION).toContain('video_path and legacy');
    expect(TOOL_DESCRIPTION).toContain('are top-level only');
  });

  it('计量与截止字段使用准确措辞', () => {
    expect(TOOL_DESCRIPTION).toContain('budgeted as');
    expect(TOOL_DESCRIPTION).not.toContain('billed as');
    expect(TOOL_DESCRIPTION).toContain('telemetry.stopReason="wall_clock"');
  });
});

describe('toolOutputSchema', () => {
  const schema = toolOutputSchema as unknown as {
    type: string;
    required: string[];
    properties: Record<string, { type?: string; enum?: readonly string[]; items?: { type?: string } }>;
  };

  it('声明对象根、action 必需与动作枚举', () => {
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('action');
    expect(schema.properties.action?.enum).toContain('pf_stream');
  });

  it('声明 packets/hintLines/telemetry 等 agent 可依赖字段', () => {
    expect(schema.properties.packets?.type).toBe('array');
    expect(schema.properties.packets?.items?.type).toBe('object');
    expect(schema.properties.hintLines?.type).toBe('array');
    expect(schema.properties.hintLines?.items?.type).toBe('string');
    expect(schema.properties.telemetry?.type).toBe('object');
  });
});

describe('renderContent', () => {
  it('返回完整 JSON 文本，并按 packets 顺序追加图片块', () => {
    const a = image('a');
    const b = image('b');
    const value = {
      action: 'pf_stream',
      packets: [{ packetId: 1, image: a }, { packetId: 2 }, { packetId: 3, image: b }],
      hintLines: ['hint'],
    };
    const blocks = renderContent(value);
    expect(blocks).toHaveLength(3);

    const text = blocks[0] as { type: string; text: string };
    expect(text.type).toBe('text');
    expect(JSON.parse(text.text)).toEqual(value);
    expect(blocks[1]).toEqual({ type: 'image', attachment: a });
    expect(blocks[2]).toEqual({ type: 'image', attachment: b });
  });

  it('没有 packets 时只返回文本块', () => {
    const blocks = renderContent({ action: 'probe' });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
  });
});
