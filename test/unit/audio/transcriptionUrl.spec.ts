import { describe, expect, it } from 'vitest';
import { transcriptionUrl } from '../../../src/audio/asrProviders.js';

describe('transcriptionUrl', () => {
  it('只给 origin 时补 /v1/audio/transcriptions', () => {
    expect(transcriptionUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/audio/transcriptions');
  });

  it('以 /v1 结尾时不再重复 v1', () => {
    expect(transcriptionUrl('https://api.groq.com/openai/v1/')).toBe(
      'https://api.groq.com/openai/v1/audio/transcriptions',
    );
  });

  it('直接粘贴完整端点时原样使用', () => {
    expect(transcriptionUrl('https://api.siliconflow.cn/v1/audio/transcriptions')).toBe(
      'https://api.siliconflow.cn/v1/audio/transcriptions',
    );
  });
});
