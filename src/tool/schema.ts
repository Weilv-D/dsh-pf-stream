/**
 * 工具参数与输出 Schema（宿主允许的 JSON Schema 关键字子集内）。
 *
 * parameters 采用「属性名 → 值 schema」映射形式（宿主 dsh-tools 契约）。
 * 数值边界（pts_window 越界、roi_hint 区间、max_packets/max_tokens_budget 上限）
 * 由入口适配器按规格《五、双层自适应调节与统一参数映射》§1.3 钳制，不在
 * Schema 层声明 minimum/maximum（该关键字不在宿主允许子集内）。
 */

export const TOOL_NAME = 'dsh-pf-stream';

export const INTENT_DESCRIPTION =
  '统一采样与检视指令：' +
  "1) 默认流式感知 action='pf_stream'（文字/细节传 focus='detail'，动作/运镜传 focus='motion'，增减密度传 mode='dense'|'sparse'）；" +
  '2) 定点时间戳高清检视传 action=\'timestamps\' 与 timestamps_ms；' +
  '3) 均匀步长抽帧传 action=\'uniform\' 与 interval_ms/frame_count；' +
  "4) 仅探测视频元数据传 action='probe'；" +
  '5) 局部区域聚焦或放大传归一化 roi_hint。';

/** 宿主 dsh-tools assertSupportedJsonSchema 允许的关键字子集内的值 schema。 */
export interface ValueSchema {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';
  enum?: Array<string | number>;
  const?: string | number;
  properties?: Record<string, ValueSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ValueSchema;
  description?: string;
}

export const intentValueSchema: ValueSchema = {
  type: 'object',
  description: INTENT_DESCRIPTION,
  properties: {
    action: { type: 'string', enum: ['pf_stream', 'timestamps', 'uniform', 'probe'] },
    mode: { type: 'string', enum: ['dense', 'standard', 'sparse'] },
    focus: { type: 'string', enum: ['motion', 'detail', 'balanced'] },
    pts_window: { type: 'array', items: { type: 'number' }, description: '处理时间窗 [start_ms, end_ms]（PTS 域）' },
    timestamps_ms: { type: 'array', items: { type: 'number' }, description: '确定性抽帧时间戳列表（毫秒）' },
    interval_ms: { type: 'number', description: '均匀抽帧间隔（毫秒）' },
    frame_count: { type: 'number', description: '均匀抽帧目标总帧数' },
    roi_hint: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['x', 'y', 'w', 'h'],
      description: '归一化 ROI，[0, 1] 范围',
    },
    full_frame: { type: 'boolean', description: '强制保留全画幅（禁用 1:1 质心裁剪）' },
    max_packets: { type: 'number', description: '本次调用最多返回画布包数' },
    max_tokens_budget: { type: 'number', description: '本次调用视觉 Token 预算上限' },
    reset: { type: 'boolean', description: '重置会话意图为默认基准' },
  },
  additionalProperties: false,
};

/** 历史便捷字段（顶层）：由入口适配器归一化为标准 IntentDirective（《五》§1.1）。 */
export const legacyValueSchemas: Record<string, ValueSchema> = {
  start_time: { type: 'number', description: '起始时间（秒或毫秒，≤2×时长数值判秒；归一化为 intent.pts_window）' },
  end_time: { type: 'number', description: '结束时间（秒或毫秒；归一化为 intent.pts_window）' },
  time_range: { type: 'array', items: { type: 'number' }, description: '时间范围 [start, end]（秒或毫秒）' },
  timestamps: { type: 'array', items: { type: 'number' }, description: '抽帧时间戳列表（秒或毫秒，触发 timestamps 检视）' },
  fps: { type: 'number', description: '均匀抽帧帧率（触发 uniform 检视）' },
  interval: { type: 'number', description: '均匀抽帧间隔（秒或毫秒，触发 uniform 检视）' },
  num_frames: { type: 'number', description: '均匀抽帧目标总帧数（触发 uniform 检视）' },
  crop: { type: 'object', description: '局部区域（归一化或像素坐标，归一化为 intent.roi_hint）' },
  probe_only: { type: 'boolean', description: '仅探测视频元数据（等价 action="probe"）' },
};

/** 工具 parameters：属性名 → 值 schema 映射。顶层额外声明历史便捷字段
 * （宿主会剥离未声明参数，故必须显式列出才能到达适配器）。 */
export const toolParameters: Record<string, ValueSchema> = {
  video_path: { type: 'string', description: '待处理的本地视频文件路径' },
  intent: intentValueSchema,
  ...legacyValueSchemas,
};

export const TOOL_DESCRIPTION =
  'Look at a local video: adaptive dual-scale streaming perception (low-token P units during motion, ' +
  'high-detail F units at settle) plus deterministic inspection (probe metadata, exact-timestamp frames, ' +
  'uniform slicing, RoI zoom). All canvases are 42px-grid aligned and billed as r*(c+1)+2 vision tokens. ' +
  'Use action="probe" for metadata, action="timestamps"/"uniform" for deterministic inspection, ' +
  'default action="pf_stream" for continuous event viewing.';

/** 输出 schema：随各里程碑交付逐步收紧，当前为对象根。 */
export const toolOutputSchema = {
  type: 'object',
} as const;
