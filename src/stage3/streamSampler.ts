/**
 * Stage 3 —— 流式采样引擎（pf_stream 主体，规格《三》《四》《六》）。
 *
 * 单遍顺序解码（decodeRangeStreaming）+ 逐帧感知 + 施密特状态机驱动：
 * - P 单元：MOTION 位移积分（A += α·d·ΔPTS/33.3，A ≥ S_eff 出一张 336 P）；
 * - F 单元：SETTLE 观察窗最清晰帧 / MOTION PEAK 擂台 / SWITCH 静态保底（黑场顺延 ≤300ms）；
 * - 四路流式发包：PATH_SETTLE / PEAK_FULL / PEAK_TIMEOUT / SWITCH_STATIC（DETERMINISTIC 在
 *   deterministicRouter）；M2 阶段全部 history_mode = 'initial'；
 * - R4 快定格：SWITCH 时 T_settle_eff 直写 80ms，首个 MOTION 或静态稳定后恢复基准；
 * - 近邻去重：<500ms 且期间 d < H_low 的未发出 F 原地覆盖；
 * - 长静止心跳：每 5s（PTS）一条轻量 JSON，独立编号空间，不参与包龄计算；
 * - 时间判定全部基于 PTS（契约 5）；相同视频输入产出幂等事件流（case 19 断言）。
 */

import { decodeRangeStreaming } from '../stage0/decoder.js';
import {
  blockGridPos,
  blockWeights,
  createPerceptionContext,
  perceiveFrame,
  resetTemporalContext,
  toGray64x36,
} from '../stage1/perceive.js';
import {
  SchmittMachine,
  beatsArena,
  createClarityState,
  updateClarity,
  type ClarityState,
} from '../stage2/stateMachine.js';
import { classifySceneChange, isBlackOrBlownFrame } from '../stage2/switchDetector.js';
import { packCanvas, timelineHintLine, type PacketArtifact, type UnitInput } from '../stage4/canvasPacker.js';
import { applyViewport, planViewport } from '../stage4/viewport.js';
import { baselinesFromIntent, type StreamBaselines } from '../stage5/intent.js';
import { StreamController } from '../stage5/controller.js';
import type {
  CtrlTickLogEntry,
  PendingPUnit,
  ProbeResult,
  RoiHint,
  SessionIntent,
  StateMachineSnapshot,
  StreamCursor,
  TriggerPath,
} from '../types.js';
import type { RgbImage } from '../utils/image.js';

export const STEP_MS = 33.3;
export const T_MERGE_MS = 50;
export const SWITCH_STATIC_MS = 250;
export const F_SWITCH_DEFER_MAX_MS = 300;
export const NEAR_DUP_MS = 500;
export const HEARTBEAT_INTERVAL_MS = 5000;

export interface StreamRunOptions {
  ffmpegPath: string;
  /** 末帧探测与定点索引用的 ffprobe；缺省由 ffmpegPath 同目录派生。 */
  ffprobePath?: string | undefined;
  renderVisualId: boolean;
  /** 流式窗口长度（defaultStreamWindowMs）。 */
  windowMs: number;
  /** 窗口起点（intent.pts_window[0]）；缺省从会话游标续流。 */
  windowStartMs?: number | undefined;
  /** 流式工作副本上限（streamWorkMaxEdge，0 = 不限）。 */
  streamWorkMaxEdge: number;
  maxPackets: number;
  maxTokensBudget: number;
  appliedIntentId: string;
  packetIdStart: number;
  globalIdStart: number;
  heartbeatSeqStart: number;
  signal?: AbortSignal | undefined;
}

export interface StreamTelemetry {
  decodeMs: number;
  perceiveMs: number;
  packMs: number;
  pathLatencyMs: number;
  framesDecoded: number;
  framesStepped: number;
  ptsRealign: number;
  /** 每次 ffmpeg 解码进程的 argv 快照（单遍解码断言：计数=1、单次 -ss）。 */
  ffmpegSpawns: string[][];
  /** 运行期间同一时刻持有的 672 擂台槽位数峰值（单槽位约束：≤2 = MOTION 1 + SETTLE 1）。 */
  arenaMaxHeld: number;
  window: [number, number];
  stopReason: 'budget_packets' | 'budget_tokens' | 'end_of_window' | 'end_of_stream';
  ctrlParams: StreamBaselines;
  /** 500ms 节拍生效值轨迹（R1/R2/R3/R4 断言用）。 */
  ctrlTickLog: CtrlTickLogEntry[];
}

export interface StreamRunResult {
  packets: PacketArtifact[];
  hintLines: string[];
  heartbeats: Array<{ seq: number; ptsMs: number }>;
  telemetry: StreamTelemetry;
  nextCursor: StreamCursor;
  /** 本次运行实际消耗的序号终值（含本次）。 */
  counters: { packetSeq: number; globalUnitSeq: number; heartbeatSeq: number };
}

interface CapturedUnit {
  ptsMs: number;
  image: RgbImage;
  sourceCropBbox: [number, number, number, number];
}

interface MotionArenaEntry {
  ptsMs: number;
  rho: number;
  g: number;
  image: RgbImage;
  sourceCropBbox: [number, number, number, number];
}

interface RuntimeState {
  machine: SchmittMachine;
  clarity: ClarityState;
  lastStepPtsMs: number | null;
  pendingP: CapturedUnit[];
  motionArena: MotionArenaEntry | null;
  settleArena: (CapturedUnit & { g: number }) | null;
  pendingF: (CapturedUnit & { eventType: 'SETTLE' }) | null;
  fSwitchWaitDeadline: number | null;
  fSwitchImage: CapturedUnit | null;
  motionEnteredAtPtsMs: number | null;
  lastFEmittedPtsMs: number | null;
  lastHeartbeatPtsMs: number | null;
  tokensUsed: number;
}

class StopIteration extends Error {
  constructor(public reason: 'budget_packets' | 'budget_tokens') {
    super(reason);
  }
}

export async function runStreamPass(
  videoPath: string,
  probe: ProbeResult,
  sessionIntent: SessionIntent,
  cursor: StreamCursor,
  options: StreamRunOptions,
): Promise<StreamRunResult> {
  const baselines = baselinesFromIntent(sessionIntent.mode, sessionIntent.focus);
  const weights = blockWeights(sessionIntent.roiHint);

  const w0 = Math.min(options.windowStartMs ?? cursor.lastConsumedPtsMs, probe.lastPtsMs);
  const w1 = Math.min(w0 + options.windowMs, probe.lastPtsMs);
  const ctrl = new StreamController(baselines, w0, cursor.snapshot.ctrl);
  const packets: PacketArtifact[] = [];
  const hintLines: string[] = [];
  const heartbeats: Array<{ seq: number; ptsMs: number }> = [];
  const counters = {
    packetSeq: options.packetIdStart - 1,
    globalUnitSeq: options.globalIdStart - 1,
    heartbeatSeq: options.heartbeatSeqStart - 1,
  };

  if (w0 >= probe.lastPtsMs) {
    return {
      packets,
      hintLines,
      heartbeats,
      telemetry: emptyTelemetry(baselines, [w0, w1], 'end_of_stream'),
      nextCursor: cursor,
      counters,
    };
  }

  const rt = restoreRuntime(cursor);
  const perception = createPerceptionContext();
  const decodeStart = Date.now();
  let perceiveMs = 0;
  let packMs = 0;
  let framesDecoded = 0;
  let framesStepped = 0;
  let ptsRealign = 0;
  let stopReason: StreamTelemetry['stopReason'] = 'end_of_window';
  let lastPtsOfWindow: number | null = null;
  const ffmpegSpawns: string[][] = [];
  let arenaMaxHeld = 0;

  /**
   * 发包：形态由可用单元数决定，调用方不必保证计数。
   *
   * 不变量（packCanvas 的硬约束）：FORM_1 = 4P+1F，FORM_2 = 4P，
   * FORM_3 = 1F，FORM_4 = 1~3P+1F。因此：
   * - 无 F 时只有 FORM_2 成立，必须恰好 4P；不足 4P 本包不成立，保留
   *   pendingP 等后续触发，否则会抛 “FORM_2 需要 4P” 让整次调用失败；
   * - 有 F 时 P 最多消费 4 张（多出的留在 pendingP，下一包继续）；
   * - SWITCH_STATIC 固定 FORM_3，只发 F、不消费 P（switch 效果已清空 pendingP）。
   */
  const emit = (trigger: TriggerPath, withF = true): void => {
    const t0 = performance.now();
    let fUnit: (CapturedUnit & { eventType: UnitInput['eventType'] }) | null = null;
    if (trigger === 'SETTLE' && rt.pendingF) fUnit = rt.pendingF;
    else if (trigger === 'PEAK_FULL' && withF && rt.motionArena) {
      fUnit = {
        ptsMs: rt.motionArena.ptsMs,
        image: rt.motionArena.image,
        sourceCropBbox: rt.motionArena.sourceCropBbox,
        eventType: 'MOTION',
      };
    } else if (trigger === 'PEAK_TIMEOUT' && (rt.motionArena ?? rt.settleArena)) {
      const src = rt.motionArena ?? rt.settleArena!;
      fUnit = {
        ptsMs: src.ptsMs,
        image: src.image,
        sourceCropBbox: src.sourceCropBbox,
        eventType: 'MOTION',
      };
    } else if (trigger === 'SWITCH_STATIC' && rt.fSwitchImage) {
      fUnit = { ...rt.fSwitchImage, eventType: 'SWITCH_STATIC' };
    }

    const pCount =
      trigger === 'SWITCH_STATIC'
        ? 0
        : fUnit
          ? Math.min(rt.pendingP.length, 4)
          : rt.pendingP.length >= 4
            ? 4
            : 0;
    // 无 F 且不足 4P：本包不成立。不清理任何待发/擂台状态，等下一次触发。
    if (pCount === 0 && !fUnit) return;

    const units: UnitInput[] = [];
    for (const p of rt.pendingP.splice(0, pCount)) {
      counters.globalUnitSeq++;
      units.push({
        globalId: counters.globalUnitSeq,
        ptsMs: p.ptsMs,
        scale: '1x1_P',
        eventType: 'MOTION',
        image: p.image,
        sourceCropBbox: p.sourceCropBbox,
      });
    }

    let form: 'FORM_1_STANDARD_STRIP' | 'FORM_2_COMPACT_4P' | 'FORM_3_COMPACT_1F' | 'FORM_4_PARTIAL_STRIP';
    if (trigger === 'SWITCH_STATIC') form = 'FORM_3_COMPACT_1F';
    else if (!fUnit) form = 'FORM_2_COMPACT_4P';
    else if (units.length >= 4) form = 'FORM_1_STANDARD_STRIP';
    else if (units.length >= 1) form = 'FORM_4_PARTIAL_STRIP';
    else form = 'FORM_3_COMPACT_1F';

    if (fUnit) {
      counters.globalUnitSeq++;
      units.push({
        globalId: counters.globalUnitSeq,
        ptsMs: fUnit.ptsMs,
        scale: '2x2_F',
        eventType: fUnit.eventType,
        image: fUnit.image,
        sourceCropBbox: fUnit.sourceCropBbox,
      });
    }

    if (trigger === 'SETTLE') rt.pendingF = null;
    if (trigger === 'PEAK_FULL' && withF) rt.motionArena = null;
    if (trigger === 'PEAK_TIMEOUT') {
      rt.motionArena = null;
      rt.settleArena = null;
    }
    if (trigger === 'SWITCH_STATIC') rt.fSwitchImage = null;

    counters.packetSeq++;
    const artifact = packCanvas(form, units, {
      packetId: counters.packetSeq,
      appliedIntentId: options.appliedIntentId,
      appliedCtrlId: ctrl.activeCtrlIds(),
      renderVisualId: options.renderVisualId,
      triggerPath: trigger,
    });
    packets.push(artifact);
    hintLines.push(timelineHintLine(artifact.packet, sessionIntent.roiHint ?? null));
    if (fUnit) {
      rt.lastFEmittedPtsMs = fUnit.ptsMs;
    }
    rt.tokensUsed += form === 'FORM_1_STANDARD_STRIP' || form === 'FORM_4_PARTIAL_STRIP' ? 530 : 274;
    packMs += performance.now() - t0;
  };

  const capture = (frame: RgbImage, ptsMs: number, slot: 'P' | 'F', dLocal: number, topK: number[]): CapturedUnit => {
    let roi: RoiHint | null = sessionIntent.roiHint ?? null;
    const fullFrame = sessionIntent.fullFrame;
    if (!roi && !fullFrame && dLocal > 0 && topK.length > 0) {
      // 运动极值块簇质心 → 1:1 正方形视窗（契约 4）
      let cx = 0;
      let cy = 0;
      for (const k of topK) {
        const p = blockGridPos(k);
        cx += (p.col + 0.5) / 8;
        cy += (p.row + 0.5) / 4;
      }
      cx /= topK.length;
      cy /= topK.length;
      const side = Math.min(frame.width, frame.height) / Math.max(frame.width, frame.height);
      roi = { x: clamp01(cx - side / 2), y: clamp01(cy - side / 2), w: side, h: side };
    }
    const plan = planViewport({
      displayWidth: frame.width,
      displayHeight: frame.height,
      roi: roi ?? undefined,
      fullFrame,
      slot,
    });
    // sourceCropBbox 回映射到源视频显示坐标系（工作副本等比缩放）
    const sx = probe.displayWidth / frame.width;
    const sy = probe.displayHeight / frame.height;
    const [x, y, w, h] = plan.sourceCropBbox;
    return {
      image: applyViewport(frame, plan, slot),
      ptsMs,
      sourceCropBbox: [Math.round(x * sx), Math.round(y * sy), Math.round(w * sx), Math.round(h * sy)],
    };
  };

  try {
    const result = await decodeRangeStreaming(
      videoPath,
      w0,
      w1,
      {
        ffmpegPath: options.ffmpegPath,
        ffprobePath: options.ffprobePath,
        displayWidth: probe.displayWidth,
        displayHeight: probe.displayHeight,
        workMaxEdge: options.streamWorkMaxEdge,
        onFfmpegSpawn: (argv) => ffmpegSpawns.push(argv.slice()),
        signal: options.signal,
      },
      (frame, ptsMs) => {
        framesDecoded++;
        // 等效 30fps 步长门（契约 5）：ΔPTS ≥ 33.3ms 才进入感知
        if (rt.lastStepPtsMs !== null && ptsMs - rt.lastStepPtsMs < STEP_MS) return;
        framesStepped++;
        const t0 = performance.now();
        const gray = toGray64x36(frame.width, frame.height, frame.data);
        const signal = perceiveFrame(perception, ptsMs, gray, weights, ctrl.live.HHighEff);
        const verdict = classifySceneChange(signal.switchCandidateBlocks, signal.histL1);

        const step = rt.machine.step(
          ptsMs,
          signal.d,
          {
            hHighEff: ctrl.live.HHighEff,
            tSettleEff: ctrl.live.TSettleEff,
            tMergeMs: T_MERGE_MS,
            switchStaticMs: SWITCH_STATIC_MS,
          },
          verdict,
        );

        const stepScale = rt.lastStepPtsMs === null ? 1 : (ptsMs - rt.lastStepPtsMs) / STEP_MS;
        rt.lastStepPtsMs = ptsMs;
        if (rt.lastHeartbeatPtsMs === null) rt.lastHeartbeatPtsMs = ptsMs;

        // 清晰度 EMA 与 ρ
        const rho = updateClarity(rt.clarity, signal.g);

        // ---- 状态机效果 ----
        for (const effect of step.effects) {
          switch (effect) {
            case 'switch': {
              // 原子步骤 1-5 在状态机内；采样器侧：清队列、废擂台、R4 直写、感知时序重置
              rt.pendingP.length = 0;
              rt.pendingF = null;
              rt.motionArena = null;
              rt.settleArena = null;
              ctrl.onSwitch(ptsMs);
              resetTemporalContext(perception);
              updateClarity(rt.clarity, signal.g, { resetWarmup: true });
              rt.fSwitchImage = null;
              if (isBlackOrBlownFrame(gray)) {
                rt.fSwitchWaitDeadline = ptsMs + F_SWITCH_DEFER_MAX_MS; // 黑场/过曝顺延
              } else {
                rt.fSwitchWaitDeadline = null;
                rt.fSwitchImage = capture(frame, ptsMs, 'F', signal.dLocal, signal.topK);
              }
              break;
            }
            case 'enter_motion': {
              rt.motionArena = null;
              // 合并确认窗内运动复发：已锁定的待发 F 保留，
              // 留待与新 P 簇合并发出（状态机 merge_emit 路径）；
              // R4 恢复路径①由 controller.onFrameStepped 的状态迁移检测完成
              rt.motionEnteredAtPtsMs = ptsMs;
              updateClarity(rt.clarity, signal.g, { resetWarmup: true });
              break;
            }
            case 'settle_enter':
              rt.settleArena = null;
              break;
            case 'settle_cancel':
              rt.motionEnteredAtPtsMs = ptsMs;
              break;
            case 'settle_lock': {
              // 锁定观察窗最清晰帧为待发 F。近邻（<500ms 且期间 d < H_low）时为原地覆盖语义：
              // 单槽位待发 F 直接被更清晰的停稳帧替换（M4 接入 FUnitCache 后补缓存条目清理）。
              const source = rt.settleArena;
              if (source) {
                rt.pendingF = {
                  ptsMs: source.ptsMs,
                  image: source.image,
                  sourceCropBbox: source.sourceCropBbox,
                  eventType: 'SETTLE',
                };
              }
              break;
            }
            case 'merge_emit':
              emit('SETTLE');
              break;
            case 'switch_static_emit':
              if (rt.fSwitchImage) emit('SWITCH_STATIC');
              break;
            case 'switch_motion_void':
              rt.fSwitchImage = null;
              rt.fSwitchWaitDeadline = null;
              break;
            default:
              break;
          }
        }

        // ---- 自闭环节拍（500ms PTS；R3>R1>R2 求值 + 一阶平滑，R4 状态迁移恢复）----
        ctrl.onFrameStepped(ptsMs, signal.d, signal.rFlip, rt.machine.state);

        // ---- MOTION 段：位移积分采样 + PEAK 擂台 + 容量/超时边界 ----
        if (rt.machine.state === 'MOTION') {
          rt.machine.integratorA += ctrl.alphaFor(signal.alpha) * signal.d * stepScale;
          while (rt.machine.integratorA >= ctrl.live.SEff) {
            rt.machine.integratorA = Math.min(
              rt.machine.integratorA - ctrl.live.SEff,
              ctrl.live.SEff - 1e-4,
            );
            rt.pendingP.push(capture(frame, ptsMs, 'P', signal.dLocal, signal.topK));
          }
          if (rt.clarity.warmupLeft <= 0 && beatsArena(rt.motionArena, rho)) {
            const f = capture(frame, ptsMs, 'F', signal.dLocal, signal.topK);
            rt.motionArena = {
              ptsMs,
              rho,
              g: signal.g,
              image: f.image,
              sourceCropBbox: f.sourceCropBbox,
            };
          }
          if (rt.pendingP.length >= 4) {
            const cooled =
              rt.lastFEmittedPtsMs === null ||
              ptsMs - rt.lastFEmittedPtsMs >= ctrl.live.TCoolEff;
            const withF = cooled && rt.clarity.warmupLeft <= 0 && rt.motionArena !== null;
            if (withF) emit('PEAK_FULL', true);
            else emit('PEAK_FULL', false); // 未满冷却/预热期 → 纯 4P（FORM_2）
          }
          if (
            rt.motionEnteredAtPtsMs !== null &&
            ptsMs - rt.motionEnteredAtPtsMs >= ctrl.live.tMaxMEff &&
            rt.pendingP.length >= 1 &&
            rt.pendingP.length <= 3
          ) {
            emit('PEAK_TIMEOUT');
            rt.motionEnteredAtPtsMs = ptsMs;
          }
        }

        // ---- SETTLE 段：观察窗最清晰帧跟踪 ----
        if (
          rt.machine.state === 'SETTLE' &&
          (rt.settleArena === null || signal.g > rt.settleArena.g)
        ) {
          rt.settleArena = { ...capture(frame, ptsMs, 'F', signal.dLocal, signal.topK), g: signal.g };
        }

        // ---- F_switch 黑场顺延捕获 ----
        if (
          rt.machine.fSwitchPending &&
          !rt.fSwitchImage &&
          rt.fSwitchWaitDeadline !== null &&
          !isBlackOrBlownFrame(gray)
        ) {
          rt.fSwitchImage = capture(frame, ptsMs, 'F', signal.dLocal, signal.topK);
          rt.fSwitchWaitDeadline = null;
        } else if (
          rt.machine.fSwitchPending &&
          !rt.fSwitchImage &&
          rt.fSwitchWaitDeadline !== null &&
          ptsMs > rt.fSwitchWaitDeadline
        ) {
          rt.fSwitchImage = capture(frame, ptsMs, 'F', signal.dLocal, signal.topK); // 300ms 兜底
          rt.fSwitchWaitDeadline = null;
        }

        // ---- 长静止心跳（5s PTS，独立编号空间）----
        if (
          rt.machine.state === 'STATIC' &&
          rt.lastHeartbeatPtsMs !== null &&
          ptsMs - rt.lastHeartbeatPtsMs >= HEARTBEAT_INTERVAL_MS
        ) {
          counters.heartbeatSeq++;
          heartbeats.push({ seq: counters.heartbeatSeq, ptsMs });
          rt.lastHeartbeatPtsMs = ptsMs;
        }

        // 擂台单槽不变量观测：同一时刻持有的 672 槽位数（MOTION 擂台 + SETTLE 观察窗各 1）
        const arenaHeld = (rt.motionArena !== null ? 1 : 0) + (rt.settleArena !== null ? 1 : 0);
        if (arenaHeld > arenaMaxHeld) arenaMaxHeld = arenaHeld;
        perceiveMs += performance.now() - t0;
        lastPtsOfWindow = ptsMs;

        // ---- 预算停止（意图层上限）----
        if (packets.length >= options.maxPackets) throw new StopIteration('budget_packets');
        if (rt.tokensUsed + 274 > options.maxTokensBudget) throw new StopIteration('budget_tokens');
      },
    );
    ptsRealign = result.realigned;
  } catch (error) {
    if (error instanceof StopIteration) {
      stopReason = error.reason;
    } else {
      throw error;
    }
  }

  // 窗口末端已钳制到流末帧（lastPtsMs）且无预算提前停止 → 流已耗尽。
  if (stopReason === 'end_of_window' && w1 >= probe.lastPtsMs) {
    stopReason = 'end_of_stream';
  }

  return {
    packets,
    hintLines,
    heartbeats,
    telemetry: {
      decodeMs: Date.now() - decodeStart,
      perceiveMs,
      packMs,
      pathLatencyMs: lastPtsOfWindow !== null ? lastPtsOfWindow - w0 : 0,
      framesDecoded,
      framesStepped,
      ptsRealign,
      ffmpegSpawns,
      arenaMaxHeld,
      window: [w0, w1],
      stopReason,
      ctrlParams: { ...ctrl.live },
      ctrlTickLog: ctrl.tickLog.slice(),
    },
    nextCursor: buildCursor(rt, cursor, lastPtsOfWindow ?? w0, ctrl),
    counters,
  };
}

// ---------------------------------------------------------------------------
// 游标持久化
// ---------------------------------------------------------------------------

function restoreRuntime(cursor: StreamCursor): RuntimeState {
  const s = cursor.snapshot;
  const machine = new SchmittMachine({
    state: s.state,
    enteredAtPtsMs: s.enteredAtPtsMs,
    integratorA: s.integratorA,
    settleStartPtsMs: s.settleStartPtsMs,
  });
  machine.mergeStartPtsMs = s.mergeStartPtsMs ?? null;
  machine.switchStaticSincePtsMs = s.switchStaticSincePtsMs ?? null;
  machine.fSwitchPending = s.fSwitchPending ?? false;
  return {
    machine,
    clarity: {
      gEma: s.gEma,
      warmupLeft: s.clarityWarmupLeft ?? s.emaWarmupLeft,
      rhoHistory: s.rhoHistory ?? [],
    },
    lastStepPtsMs: cursor.lastConsumedPtsMs,
    pendingP: (cursor.pendingPUnits ?? []).map((p) => ({
      ptsMs: p.ptsMs,
      image: { width: 336, height: 336, data: p.image336 },
      sourceCropBbox: p.sourceCropBbox,
    })),
    motionArena: null,
    settleArena: null,
    pendingF: null,
    fSwitchWaitDeadline: null,
    fSwitchImage: null,
    motionEnteredAtPtsMs: s.motionEnteredAtPtsMs ?? null,
    lastFEmittedPtsMs: cursor.lastEmittedPacketPtsMs,
    lastHeartbeatPtsMs: s.lastHeartbeatPtsMs ?? null,
    tokensUsed: 0,
  };
}

function buildCursor(rt: RuntimeState, cursor: StreamCursor, lastPts: number, ctrl: StreamController): StreamCursor {
  const snapshot: StateMachineSnapshot = {
    state: rt.machine.state,
    enteredAtPtsMs: rt.machine.enteredAtPtsMs,
    integratorA: rt.machine.integratorA,
    gEma: rt.clarity.gEma,
    emaWarmupLeft: rt.clarity.warmupLeft,
    settleStartPtsMs: rt.machine.settleStartPtsMs,
    mergeStartPtsMs: rt.machine.mergeStartPtsMs,
    switchStaticSincePtsMs: rt.machine.switchStaticSincePtsMs,
    fSwitchPending: rt.machine.fSwitchPending,
    clarityWarmupLeft: rt.clarity.warmupLeft,
    rhoHistory: rt.clarity.rhoHistory.slice(-3),
    motionEnteredAtPtsMs: rt.motionEnteredAtPtsMs,
    lastHeartbeatPtsMs: rt.lastHeartbeatPtsMs,
    ctrl: ctrl.snapshot(),
  };
  const pendingPUnits: PendingPUnit[] = rt.pendingP.map((p) => ({
    ptsMs: p.ptsMs,
    image336: p.image.data,
    sourceCropBbox: p.sourceCropBbox,
  }));
  return {
    ...cursor,
    lastConsumedPtsMs: lastPts,
    lastEmittedPacketPtsMs: rt.lastFEmittedPtsMs,
    snapshot,
    pendingPUnits,
  };
}

function emptyTelemetry(
  baselines: StreamBaselines,
  window: [number, number],
  stopReason: StreamTelemetry['stopReason'],
): StreamTelemetry {
  return {
    decodeMs: 0,
    perceiveMs: 0,
    packMs: 0,
    pathLatencyMs: 0,
    framesDecoded: 0,
    framesStepped: 0,
    ptsRealign: 0,
    ffmpegSpawns: [],
    arenaMaxHeld: 0,
    window,
    stopReason,
    ctrlParams: baselines,
    ctrlTickLog: [],
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
