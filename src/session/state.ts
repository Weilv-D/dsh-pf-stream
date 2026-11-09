/**
 * 会话状态（SessionState / StreamCursor / LRU 管理）。
 *
 * LRU 上限（2 个视频/会话）：每视频驻留状态约 1MB 量级
 * （单槽位擂台图 ~450KB + 待发 P 队列），单会话内存占用有界；
 * 进程内会话总数另有 SESSION_MEMORY_LIMIT 上限（超出淘汰最久未触达的会话）。
 * 会话状态默认内存态；持久层（storageDomain）由 src/session/persistence.ts 接入。
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ArenaCandidate,
  CanvasPacket,
  ColdRefPlan,
  SessionIntent,
  SessionState,
  SessionVideoState,
  StateMachineSnapshot,
  StreamCursor,
  VideoFingerprint,
} from '../types.js';
import type { TranscriptSegment } from '../audio/types.js';

/** 视频指纹：规范化路径 + size + mtime 联合哈希前 16 hex。 */
export function fingerprintOf(videoPath: string): VideoFingerprint {
  // stat 使用原始路径（Linux/macOS 大小写敏感，小写化会指向不存在的文件）；
  // 小写化仅用于指纹哈希输入，保证 Windows 路径大小写差异不产生重复槽位。
  const resolvedPath = resolve(videoPath);
  const st = statSync(resolvedPath);
  const normalizedPath = resolvedPath.replaceAll('\\', '/').toLowerCase();
  const digest = createHash('sha256')
    .update(`${normalizedPath}|${st.size}|${Math.round(st.mtimeMs)}`)
    .digest('hex');
  return {
    normalizedPath,
    sizeBytes: st.size,
    mtimeMs: Math.round(st.mtimeMs),
    sha256Short: digest.slice(0, 16),
  };
}

export function defaultSessionIntent(): SessionIntent {
  return { intentId: 'intent_0', mode: 'standard', focus: 'balanced', fullFrame: false };
}

export function createSessionState(sessionId: string): SessionState {
  return {
    sessionId,
    intent: defaultSessionIntent(),
    videos: new Map(),
    fUnitCache: new Map(),
    globalUnitSeq: 0,
    packetSeq: 0,
    intentSeq: 0,
    heartbeatSeq: 0,
    // 进程内变更序号（投递失败回滚的并发守卫）；不进快照，重建置 0。
    mutationSeq: 0,
  };
}

/** LRU 上限（会话内视频数）。 */
export const VIDEO_LRU_LIMIT = 2;

/** 取视频槽位（不存在则创建）；超过上限淘汰最旧未使用槽位。 */
export function getVideoSlot(state: SessionState, fingerprint: VideoFingerprint): SessionVideoState {
  const key = fingerprint.sha256Short;
  const existing = state.videos.get(key);
  if (existing) {
    // LRU 触达：移到 Map 尾部（最新）
    state.videos.delete(key);
    state.videos.set(key, existing);
    return existing;
  }
  while (state.videos.size >= VIDEO_LRU_LIMIT) {
    const oldest = state.videos.keys().next().value;
    if (oldest == null) break;
    state.videos.delete(oldest);
  }
  const slot = {
    cursor: {
      fingerprint,
      lastConsumedPtsMs: 0,
      lastEmittedPacketPtsMs: null,
      snapshot: {
        state: 'STATIC' as const,
        enteredAtPtsMs: 0,
        integratorA: 0,
        gEma: 0,
        emaWarmupLeft: 0,
        settleStartPtsMs: null,
      },
      pendingPUnits: [],
      lastAnchorF: null,
    },
    history: { packets: [] },
    epoch: { pendingNew: 0, coldRefs: [] },
  };
  state.videos.set(key, slot);
  return slot;
}

/** 进程内会话总数上限（防止长进程/多会话无限累积）。 */
export const SESSION_MEMORY_LIMIT = 16;

/** 进程内会话存储（key = sessionId）；Map 尾部 = 最近触达。 */
const memorySessions = new Map<string, SessionState>();

/** 把会话移到 Map 尾部并淘汰超出上限的最旧会话。 */
function touchMemorySession(state: SessionState): void {
  memorySessions.delete(state.sessionId);
  memorySessions.set(state.sessionId, state);
  while (memorySessions.size > SESSION_MEMORY_LIMIT) {
    const oldest = memorySessions.keys().next().value;
    if (oldest == null) break;
    memorySessions.delete(oldest);
  }
}

export function getSessionState(sessionId: string): SessionState {
  let state = memorySessions.get(sessionId);
  if (!state) state = createSessionState(sessionId);
  touchMemorySession(state);
  return state;
}

/** 读取会话状态（不存在返回 undefined，不创建）。 */
export function peekSessionState(sessionId: string): SessionState | undefined {
  const state = memorySessions.get(sessionId);
  if (state !== undefined) touchMemorySession(state);
  return state;
}

/** 测试辅助：清空进程内会话存储。 */
export function resetMemorySessions(): void {
  memorySessions.clear();
}

/** 测试辅助：将重建的会话状态放回进程内存储（importSessionSnapshot 配套）。 */
export function setMemorySession(state: SessionState): void {
  touchMemorySession(state);
}

// ---------------------------------------------------------------------------
// 会话快照序列化（ADR-005 重建承诺）：Buffer→base64 的字段级往返，
// 供进程重建一致性验证与宿主集成阶段的 storageDomain 落盘载荷复用。
// ---------------------------------------------------------------------------

interface SnapshotVideo {
  fingerprint: VideoFingerprint;
  lastConsumedPtsMs: number;
  lastEmittedPacketPtsMs: number | null;
  snapshot: StateMachineSnapshot;
  pendingPUnits: Array<{ ptsMs: number; image336: string; sourceCropBbox: [number, number, number, number] }>;
  lastAnchorF: StreamCursor['lastAnchorF'];
  history: {
    packets: Array<{
      packet: CanvasPacket;
      imageBytes: string;
      anchorBytes: string | null;
      anchorFContentHash: string | null;
      audioSegments?: TranscriptSegment[] | undefined;
    }>;
  };
  epoch: {
    pendingNew: number;
    coldRefs: Array<
      Omit<ColdRefPlan, 'bytes'> & { bytes: string; contentHash?: string | undefined }
    >;
  };
}

interface SnapshotDoc {
  version: 1;
  sessionId: string;
  intent: SessionIntent;
  globalUnitSeq: number;
  packetSeq: number;
  intentSeq: number;
  heartbeatSeq: number;
  fUnitCache: Array<{
    anchorFId: number;
    packetId: number;
    ptsMs: number;
    independentBytes: string;
    anchorFSha256: string;
    stripBytes?: string | undefined;
    stripSha256?: string | undefined;
    contentHash?: string | undefined;
  }>;
  videos: Array<[string, SnapshotVideo]>;
}

/** 导出会话快照（JSON 文本；Buffer 字段 base64 编码）。 */
export function exportSessionSnapshot(state: SessionState): string {
  const videos: Array<[string, SnapshotVideo]> = [];
  for (const [key, slot] of state.videos) {
    const c = slot.cursor;
    videos.push([
      key,
      {
        fingerprint: c.fingerprint,
        lastConsumedPtsMs: c.lastConsumedPtsMs,
        lastEmittedPacketPtsMs: c.lastEmittedPacketPtsMs,
        snapshot: {
          ...c.snapshot,
        },
        pendingPUnits: c.pendingPUnits.map((p) => ({
          ptsMs: p.ptsMs,
          image336: p.image336.toString('base64'),
          sourceCropBbox: p.sourceCropBbox,
        })),
        lastAnchorF: c.lastAnchorF,
        history: {
          packets: slot.history.packets.map((h) => ({
            packet: h.packet,
            imageBytes: h.imageBytes.toString('base64'),
            anchorBytes: h.anchorBytes ? h.anchorBytes.toString('base64') : null,
            anchorFContentHash: h.anchorFContentHash,
            audioSegments: h.audioSegments,
          })),
        },
        epoch: {
          pendingNew: slot.epoch.pendingNew,
          coldRefs: slot.epoch.coldRefs.map((r) => ({
            refPacketId: r.refPacketId,
            sourcePacketId: r.sourcePacketId,
            anchorFId: r.anchorFId,
            anchorFSha256: r.anchorFSha256,
            ptsMs: r.ptsMs,
            eventType: r.eventType,
            sourceCropBbox: r.sourceCropBbox,
            bytes: r.bytes.toString('base64'),
            contentHash: r.contentHash,
            audioSegments: r.audioSegments,
          })),
        },
      },
    ]);
  }
  const doc: SnapshotDoc = {
    version: 1,
    sessionId: state.sessionId,
    intent: state.intent,
    globalUnitSeq: state.globalUnitSeq,
    packetSeq: state.packetSeq,
    intentSeq: state.intentSeq,
    heartbeatSeq: state.heartbeatSeq,
    fUnitCache: [...state.fUnitCache.values()].map((e) => ({
      anchorFId: e.anchorFId,
      packetId: e.packetId,
      ptsMs: e.ptsMs,
      independentBytes: e.independentBytes.toString('base64'),
      anchorFSha256: e.anchorFSha256,
      stripBytes: e.stripBytes?.toString('base64'),
      stripSha256: e.stripSha256,
      contentHash: e.contentHash,
    })),
    videos,
  };
  return JSON.stringify(doc);
}

/** 从快照重建会话状态（exportSessionSnapshot 的逆操作）。 */
export function importSessionSnapshot(json: string): SessionState {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('会话快照不是对象');
  }
  const doc = parsed as SnapshotDoc;
  if (doc.version !== 1) throw new Error(`不支持的会话快照版本：${doc.version}`);
  if (typeof doc.sessionId !== 'string' || doc.sessionId.length === 0) {
    throw new Error('会话快照缺少有效 sessionId');
  }
  if (!Array.isArray(doc.fUnitCache) || !Array.isArray(doc.videos)) {
    throw new Error('会话快照的 fUnitCache/videos 不是数组');
  }
  const state = createSessionState(doc.sessionId);
  state.intent = doc.intent;
  state.globalUnitSeq = doc.globalUnitSeq;
  state.packetSeq = doc.packetSeq;
  state.intentSeq = doc.intentSeq;
  state.heartbeatSeq = doc.heartbeatSeq;
  state.fUnitCache = new Map(
    doc.fUnitCache.map((e) => [
      e.anchorFId,
      {
        anchorFId: e.anchorFId,
        packetId: e.packetId,
        ptsMs: e.ptsMs,
        independentBytes: Buffer.from(e.independentBytes, 'base64'),
        anchorFSha256: e.anchorFSha256,
        stripBytes: e.stripBytes != null ? Buffer.from(e.stripBytes, 'base64') : undefined,
        stripSha256: e.stripSha256,
        contentHash: e.contentHash,
      },
    ]),
  );
  for (const [key, v] of doc.videos) {
    state.videos.set(key, {
      cursor: {
        fingerprint: v.fingerprint,
        lastConsumedPtsMs: v.lastConsumedPtsMs,
        lastEmittedPacketPtsMs: v.lastEmittedPacketPtsMs,
        snapshot: {
          ...v.snapshot,
        },
        pendingPUnits: v.pendingPUnits.map((p) => ({
          ptsMs: p.ptsMs,
          image336: Buffer.from(p.image336, 'base64'),
          sourceCropBbox: p.sourceCropBbox,
        })),
        lastAnchorF: v.lastAnchorF,
      },
      history: {
        packets: v.history.packets.map((h) => ({
          packet: h.packet,
          imageBytes: Buffer.from(h.imageBytes, 'base64'),
          anchorBytes: h.anchorBytes != null ? Buffer.from(h.anchorBytes, 'base64') : null,
          anchorFContentHash: h.anchorFContentHash,
          audioSegments: h.audioSegments,
        })),
      },
      epoch: {
        pendingNew: v.epoch.pendingNew,
        coldRefs: v.epoch.coldRefs.map((r) => ({
          refPacketId: r.refPacketId,
          sourcePacketId: r.sourcePacketId,
          anchorFId: r.anchorFId,
          anchorFSha256: r.anchorFSha256,
          ptsMs: r.ptsMs,
          eventType: r.eventType,
          sourceCropBbox: r.sourceCropBbox,
          bytes: Buffer.from(r.bytes, 'base64'),
          contentHash: r.contentHash,
          audioSegments: r.audioSegments,
        })),
      },
    });
  }
  return state;
}
