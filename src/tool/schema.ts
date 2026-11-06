/**
 * 工具参数与输出 Schema。
 *
 * 本插件经 ctx.tools.register() 注册：宿主对该路径的 parameters 不做归一化，
 * 原样投影给模型（dsh-tools schemaOf()）。因此 parameters 必须是标准 JSON
 * Schema 根对象（{type:"object", properties, required}）；「属性名 → 值 schema」
 * 映射形式只在 defineTool() 路径归一化，register() 路径使用会令模型端把工具
 * 视为无参数。
 *
 * 数值边界（pts_window 越界、roi_hint 区间、max_packets/max_tokens_budget 上限）
 * 由入口适配器按规格《五、双层自适应调节与统一参数映射》§1.3 钳制，不在
 * Schema 层声明 minimum/maximum。
 */

export const TOOL_NAME = 'dsh-pf-stream';

export const INTENT_DESCRIPTION =
  '统一采样与检视指令：' +
  "1) 默认流式感知 action='pf_stream'（文字/细节传 focus='detail'，动作/运镜传 focus='motion'，增减密度传 mode='dense'|'sparse'）；" +
  '2) 定点时间戳高清检视传 action=\'timestamps\' 与 timestamps_ms；' +
  '3) 均匀步长抽帧传 action=\'uniform\' 与 interval_ms/frame_count；' +
  "4) 仅探测视频元数据传 action='probe'；" +
  '5) 局部区域聚焦或放大传归一化 roi_hint；' +
  "6) 台词与字幕传 audio（extract_subtitles 全片字幕导航，language 指定 ASR 语言）。";

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

/** parameters 根对象：register() 路径要求的标准 JSON Schema 根包装。 */
export interface ParameterRootSchema {
  type: 'object';
  properties: Record<string, ValueSchema>;
  required: string[];
  additionalProperties: boolean;
}

export const intentValueSchema: ValueSchema = {
  type: 'object',
  description: INTENT_DESCRIPTION,
  properties: {
    action: { type: 'string', enum: ['pf_stream', 'timestamps', 'uniform', 'probe'] },
    mode: { type: 'string', enum: ['dense', 'standard', 'sparse'] },
    focus: { type: 'string', enum: ['motion', 'detail', 'balanced'] },
    pts_window: { type: 'array', items: { type: 'number' }, description: '处理时间窗 [start_ms, end_ms]（PTS 域）；跨度建议 ≤240s，跨度过大时会在单次墙钟上限处提前停止（stopReason=wall_clock）' },
    timestamps_ms: { type: 'array', items: { type: 'number' }, description: '确定性抽帧时间戳列表（毫秒）；数量上限 maxFrames（默认 128），超出报错请分段' },
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
    audio: {
      type: 'object',
      description: '音频台词侧车：字幕/ASR 台词随画布包挂载（可用性取决于视频与配置）',
      properties: {
        mode: { type: 'string', enum: ['auto', 'off'], description: 'off 关闭音频侧车' },
        language: { type: 'string', description: 'ASR 语言提示（如 zh、en）' },
        extract_subtitles: { type: 'boolean', description: 'probe 返回全片字幕导航（最多 500 段，超出附 truncatedSegments）' },
        assist_focus: { type: 'boolean', description: '语音停顿引导额外 F 定格' },
      },
      additionalProperties: false,
    },
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
  bbox: { type: 'object', description: '局部区域（等价 crop，归一化或像素坐标）' },
  roi: { type: 'object', description: '局部区域（等价 crop，归一化或像素坐标）' },
  probe_only: { type: 'boolean', description: '仅探测视频元数据（等价 action="probe"）' },
};

/** 工具 parameters：标准 JSON Schema 根对象（register() 路径原样投影给模型）。
 * 顶层显式声明历史便捷字段（模型按 properties 生成实参，字段才能到达适配器）。 */
export const toolParameters: ParameterRootSchema = {
  type: 'object',
  properties: {
    video_path: { type: 'string', description: '待处理的本地视频文件路径' },
    intent: intentValueSchema,
    ...legacyValueSchemas,
  },
  required: ['video_path'],
  additionalProperties: false,
};

export const TOOL_DESCRIPTION =
  'Look at a local video: adaptive dual-scale streaming perception (low-token P units during motion, ' +
  'high-detail F units at settle) plus deterministic inspection (probe metadata, exact-timestamp frames, ' +
  'uniform slicing, RoI zoom). All canvases are 42px-grid aligned and billed as r*(c+1)+2 vision tokens. ' +
  'Usage: call action="probe" first on a new video. Default action="pf_stream" for continuous content ' +
  '(focus="detail" for text or object details, focus="motion" for actions or camera movement, ' +
  'mode="dense"/"sparse" for more or fewer process frames). ' +
  'Streaming canvases contain low-resolution process units and key freeze frames: before answering ' +
  'questions about text, numbers, or small objects, verify the target time with action="timestamps" ' +
  'and roi_hint. Pass pts_window (ms) to inspect one segment (keep spans ≤240s; very long spans stop ' +
  'at the per-call wall-clock limit with stopReason=wall_clock); use action="uniform" with interval_ms ' +
  'or frame_count for an even overview. Repeat streaming calls resume from the last position, so a ' +
  'long video can be viewed in segments. Cite packet IDs, unit IDs, and timestamps from the returned ' +
  'hint lines as evidence. When audio context is available, transcript segments are mounted on packets as ' +
  '"Audio" hint lines; cite them with their timestamps for spoken content.';

/** 输出 schema：随各里程碑交付逐步收紧，当前为对象根。 */
export const toolOutputSchema = {
  type: 'object',
} as const;
