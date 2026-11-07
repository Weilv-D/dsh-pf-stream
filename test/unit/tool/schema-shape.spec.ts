/**
 * 工具 schema 形态与调用前置校验回归（v0.2.3 参数丢失修复）。
 *
 * 背景：本插件经 ctx.tools.register() 注册，宿主对该路径的 parameters
 * 不做归一化、原样投影给模型。parameters 必须是标准 JSON Schema 根对象；
 * 「属性名 → 值 schema」映射形式只在 defineTool() 路径归一化，register()
 * 路径使用会令模型端把工具视为无参数（实参恒为 {}）。
 */

import { describe, expect, it } from 'vitest';
import { toolParameters } from '../../../lib/tool/schema.js';
import { PfStreamError } from '../../../lib/errors.js';
import { handleToolCall, type ToolDeps, type ToolExec } from '../../../lib/tool/handler.js';

describe('toolParameters 根形状（register 路径契约）', () => {
  it('根对象为 {type:"object", properties, required:["video_path"]}', () => {
    expect(toolParameters.type).toBe('object');
    expect(Array.isArray(toolParameters.required)).toBe(true);
    expect(toolParameters.required).toContain('video_path');
    expect(toolParameters.properties.video_path?.type).toBe('string');
    expect(toolParameters.properties.intent?.type).toBe('object');
  });

  it('properties 显式声明 11 个历史便捷字段（模型按 properties 生成实参）', () => {
    const legacy = [
      'start_time', 'end_time', 'time_range', 'timestamps', 'fps',
      'interval', 'num_frames', 'crop', 'bbox', 'roi', 'probe_only',
    ];
    for (const key of legacy) {
      expect(toolParameters.properties[key], `缺少顶层字段 ${key}`).toBeDefined();
    }
  });

  it('13 个 flat intent 别名可放顶层，legacy 别名只在顶层', () => {
    const flat = [
      'action', 'mode', 'focus', 'pts_window', 'timestamps_ms', 'interval_ms',
      'frame_count', 'roi_hint', 'full_frame', 'max_packets', 'max_tokens_budget',
      'reset', 'audio',
    ];
    for (const key of flat) {
      expect(toolParameters.properties[key], `缺少顶层别名 ${key}`).toBeDefined();
    }
    const intentProperties = toolParameters.properties.intent?.properties ?? {};
    for (const key of [...flat]) {
      expect(intentProperties[key], `intent 缺少标准字段 ${key}`).toBeDefined();
    }
    expect(intentProperties.video_path).toBeUndefined();
    for (const key of ['start_time', 'time_range', 'crop', 'bbox', 'roi', 'probe_only']) {
      expect(intentProperties[key], `legacy 字段 ${key} 不应在 intent 内`).toBeUndefined();
    }
  });
});

describe('handleToolCall video_path 前置校验', () => {
  const deps: ToolDeps = {
    probe: async () => {
      throw new Error('probe 不应被调用');
    },
  };

  it('空实参抛 PFSTREAM_ARGS_VIDEO_PATH（probe 先行前给出明确错误码）', async () => {
    const exec = { signal: new AbortController().signal } as ToolExec;
    await expect(handleToolCall({} as never, exec, deps)).rejects.toMatchObject({
      name: 'PfStreamError',
      code: 'PFSTREAM_ARGS_VIDEO_PATH',
    });
  });

  it('非字符串 video_path 抛 PFSTREAM_ARGS_VIDEO_PATH', async () => {
    const exec = { signal: new AbortController().signal } as ToolExec;
    await expect(
      handleToolCall({ video_path: 42 } as never, exec, deps),
    ).rejects.toBeInstanceOf(PfStreamError);
  });
});
