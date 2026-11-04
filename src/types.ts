/**
 * dsh-pf-stream 类型全集。
 *
 * 来源：技术方案 §4.5（规格《八、第一阶段执行指令》§8.2.1 全集 + 架构新增类型）
 * 与 §5.1（插件配置项 Schema）。坐标约定：token_grid_bbox 为矩阵行列序
 * [row_start, col_start, row_end, col_end]（42px 超像素单位）；content_pixel_bbox
 * 与 source_crop_bbox 为笛卡尔像素序 [x, y, w, h] 或 [x_min, y_min, x_max, y_max]，
 * 后者满足 x = 42*col, y = 42*row。source 坐标一律处于转正后的显示坐标系。
 */

// ---------------------------------------------------------------------------
// 消费端契约类型
// ---------------------------------------------------------------------------

export interface ProbeResult {
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  rotation: 0 | 90 | 180 | 270;
  durationMs: number;
  lastPtsMs: number;
  avgFps: number;
  codec: string;
  audioStreams: Array<{ index: number; codec: string; channels?: number }>;
  subtitleStreams: Array<{ index: number; codec: string; language?: string }>;
}

/** 视频检视领域历史便捷字段；由入口适配器归一化为 IntentDirective。 */
export interface LegacyInspectionParams {
  start_time?: number | string;
  end_time?: number | string;
  time_range?: [number | string, number | string];
  timestamps?: Array<number | string>;
  fps?: number;
  interval?: number;
  num_frames?: number;
  frame_count?: number;
  crop?: { x: number; y: number; w: number; h: number };
  bbox?: { x: number; y: number; w: number; h: number };
  roi?: { x: number; y: number; w: number; h: number };
  probe_only?: boolean;
}

export interface RoiHint {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type StreamAction = 'pf_stream' | 'timestamps' | 'uniform' | 'probe';
export type DensityMode = 'dense' | 'standard' | 'sparse';
export type FocusBias = 'motion' | 'detail' | 'balanced';

export interface IntentDirective {
  action?: StreamAction;
  mode?: DensityMode;
  focus?: FocusBias;
  roi_hint?: RoiHint;
  full_frame?: boolean;
  pts_window?: [number, number];
  timestamps_ms?: number[];
  interval_ms?: number;
  frame_count?: number;
  max_packets?: number;
  max_tokens_budget?: number;
  reset?: boolean;
}

export interface SessionIntent {
  intentId: string;
  mode: DensityMode;
  focus: FocusBias;
  roiHint?: RoiHint | undefined;
  fullFrame: boolean;
}

// ---------------------------------------------------------------------------
// 感知与状态机类型
// ---------------------------------------------------------------------------

export interface BlockSignal {
  row: number;
  col: number;
  deltaRaw: number;
  delta: number;
  weight: number;
  sobelMean: number;
}

export interface FrameSignal {
  ptsMs: number;
  dGlobal: number;
  dLocal: number;
  d: number;
  g: number;
  gEma: number;
  rho: number;
  rFlip: number;
  alpha: number;
  blocks: BlockSignal[];
}

export type StateKind = 'STATIC' | 'MOTION' | 'SETTLE' | 'SWITCH';

export interface StateEvent {
  type: StateKind;
  ptsMs: number;
  signal: FrameSignal;
  reason: string;
}

export interface ArenaCandidate {
  ptsMs: number;
  rho: number;
  g: number;
  image672: Buffer;
  sourceCropBbox: [number, number, number, number];
}

// ---------------------------------------------------------------------------
// 画布与发包类型
// ---------------------------------------------------------------------------

export type UnitScale = '1x1_P' | '2x2_F';
export type UnitEventType = 'MOTION' | 'SETTLE' | 'SWITCH_STATIC' | 'DETERMINISTIC';
export type LayoutForm = 'FORM_1_STANDARD_STRIP' | 'FORM_2_COMPACT_4P' | 'FORM_3_COMPACT_1F' | 'FORM_4_PARTIAL_STRIP';
export type TriggerPath = 'SETTLE' | 'PEAK_FULL' | 'PEAK_TIMEOUT' | 'SWITCH_STATIC' | 'DETERMINISTIC';
export type HistoryMode = 'initial' | 'full_strip_ref' | 'anchor_only_ref';

export interface UnitDescriptor {
  globalId: number;
  timestampMs: number;
  scale: UnitScale;
  eventType: UnitEventType;
  /** 矩阵行列序 [row_start, col_start, row_end, col_end]，42px 超像素单位。 */
  tokenGridBbox: [number, number, number, number];
  /** 笛卡尔像素序 [x_min, y_min, x_max, y_max]。 */
  contentPixelBbox: [number, number, number, number];
  /** 该单元在源视频显示坐标系中的实际采样区域 [x, y, w, h]。 */
  sourceCropBbox: [number, number, number, number];
}

export interface CanvasPacket {
  packetId: number;
  canvasSize: [number, number];
  layoutForm: LayoutForm;
  triggerPath: TriggerPath;
  historyMode: HistoryMode;
  anchorOnlyRefPacketId: number | null;
  spatialRemap: 'anchor_to_full_canvas' | null;
  anchorFId: number | null;
  anchorFSha256: string | null;
  stripSha256: string | null;
  appliedIntentId: string;
  appliedCtrlId: string[];
  units: UnitDescriptor[];
}

export interface FUnitCacheEntry {
  anchorFId: number;
  packetId: number;
  ptsMs: number;
  independentBytes: Buffer;
  anchorFSha256: string;
  stripBytes?: Buffer;
  stripSha256?: string;
  contentHash?: string;
}

/** 发包历史环形队列：按包龄新→旧排列；热区为最近 2 包，冷区至多 maxColdRefs 包。 */
export interface HistoryRing {
  packets: CanvasPacket[];
}

// ---------------------------------------------------------------------------
// 双层调节类型
// ---------------------------------------------------------------------------

export interface ControlParams {
  SBase: number;
  STarget: number;
  SEff: number;
  TCoolBase: number;
  TCoolEff: number;
  TSettleBase: number;
  TSettleEff: number;
  HHighBase: number;
  HHighEff: number;
}

// ---------------------------------------------------------------------------
// 会话与流式状态类型
// ---------------------------------------------------------------------------

export interface VideoFingerprint {
  normalizedPath: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256Short: string;
}

export interface StateMachineSnapshot {
  state: StateKind;
  enteredAtPtsMs: number;
  integratorA: number;
  gEma: number;
  emaWarmupLeft: number;
  settleStartPtsMs: number | null;
  lastKCandidates: number[] | null;
  lastMotionVec: [number, number] | null;
  arena: ArenaCandidate | null;
  // M2 扩展：合并窗 / 静态观察 / F_switch / R4 等采样器运行时状态
  mergeStartPtsMs?: number | null;
  switchStaticSincePtsMs?: number | null;
  fSwitchPending?: boolean;
  clarityWarmupLeft?: number;
  rhoHistory?: number[];
  motionEnteredAtPtsMs?: number | null;
  maxDSinceLastF?: number;
  lastHeartbeatPtsMs?: number | null;
  /** 自闭环控制器状态（M3 起填充）。 */
  ctrl?: ControllerSnapshot;
}

/** Stage 5 自闭环控制器的可序列化状态（游标续流用）。 */
export interface ControllerSnapshot {
  sTarget: number;
  tCoolTarget: number;
  hHighTarget: number;
  r1Active: boolean;
  r2Active: boolean;
  r3Active: boolean;
  r4Active: boolean;
  ctrlId: { r1?: string; r2?: string; r3?: string; r4?: string };
  seq: { r1: number; r2: number; r3: number; r4: number };
  lastTickPtsMs: number | null;
  rFlipRun: number;
  rFlipCalmRun: number;
  r1CondSincePtsMs: number | null;
  r2CondSincePtsMs: number | null;
  lastState: 'STATIC' | 'MOTION' | 'SETTLE' | 'SWITCH';
  stateSincePtsMs: number;
  liveSEff: number;
  liveTCoolEff: number;
  liveTSettleEff: number;
  liveHHighEff: number;
}

/** 500ms 节拍上的生效值轨迹（遥测断言用）。 */
export interface CtrlTickLogEntry {
  ptsMs: number;
  sEff: number;
  tCoolEff: number;
  tSettleEff: number;
  hHighEff: number;
  activeRules: string[];
}

export interface PendingPUnit {
  ptsMs: number;
  image336: Buffer;
  sourceCropBbox: [number, number, number, number];
}

export interface StreamCursor {
  fingerprint: VideoFingerprint;
  lastConsumedPtsMs: number;
  lastEmittedPacketPtsMs: number | null;
  snapshot: StateMachineSnapshot;
  pendingPUnits: PendingPUnit[];
  lastAnchorF: { globalId: number; ptsMs: number; emitted: boolean } | null;
}

export interface SessionVideoState {
  cursor: StreamCursor;
  history: HistoryRing;
}

export interface SessionState {
  sessionId: string;
  intent: SessionIntent;
  /** LRU，至多 2 个视频。 */
  videos: Map<string, SessionVideoState>;
  fUnitCache: Map<number, FUnitCacheEntry>;
  globalUnitSeq: number;
  packetSeq: number;
  intentSeq: number;
  ctrlSeq: Map<string, number>;
  heartbeatSeq: number;
}

// ---------------------------------------------------------------------------
// 解码与预检类型
// ---------------------------------------------------------------------------

export interface DecodePlan {
  mode: 'stream_pass' | 'seek_points';
  ptsWindow: [number, number];
  ptsIndex: number[];
  argv: string[];
  workMaxEdge: number | null;
}

export interface PrecheckVerdict {
  ok: boolean;
  packetsDropped: number[];
  truncatedCurrent: boolean;
  bytesBudget: number;
  tokensBudget: number;
}

export interface TimelineHintLine {
  packetId: number;
  text: string;
}

// ---------------------------------------------------------------------------
// 插件配置类型
// ---------------------------------------------------------------------------

export interface MeteringProfile {
  superpixelPx: 42;
  rounding: 'ceil';
  maxTokensPerImage: number;
  maxImagesPerRequest: number;
  imageCountTiersEnabled: boolean;
  legacyModes: string[];
}

export interface PfStreamPluginConfig {
  renderVisualId: boolean;
  maxPacketsPerCall: number;
  maxTokensBudgetPerCall: number;
  maxRequestBytes: number;
  maxColdRefs: number;
  telemetryEnabled: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
  tempDir?: string;
  contentHashFallback: boolean;
  defaultStreamWindowMs: number;
  streamWorkMaxEdge: number;
  epochCompactionWindow: number;
  meteringProfile: MeteringProfile;
}
