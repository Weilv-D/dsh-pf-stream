/**
 * 会话状态（SessionState / StreamCursor / LRU 管理）。
 *
 * LRU 上限（2 个视频/会话）：每视频驻留状态约 1MB 量级
 * （单槽位擂台图 ~450KB + 待发 P 队列），会话内存占用有界。
 * M2 为进程内内存态；持久层（storageDomain）在 M4 接入（ADR-005）。
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionIntent, SessionState, SessionVideoState, VideoFingerprint } from '../types.js';

/** 视频指纹：规范化路径 + size + mtime 联合哈希前 16 hex。 */
export function fingerprintOf(videoPath: string): VideoFingerprint {
  const normalizedPath = resolve(videoPath).replaceAll('\\', '/').toLowerCase();
  const st = statSync(normalizedPath);
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
    ctrlSeq: new Map(),
    heartbeatSeq: 0,
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
        lastKCandidates: null,
        lastMotionVec: null,
        arena: null,
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

/** M2 进程内会话存储（key = sessionId）；M4 换 storageDomain 持久层。 */
const memorySessions = new Map<string, SessionState>();

export function getSessionState(sessionId: string): SessionState {
  let state = memorySessions.get(sessionId);
  if (!state) {
    state = createSessionState(sessionId);
    memorySessions.set(sessionId, state);
  }
  return state;
}

/** 测试辅助：清空进程内会话存储。 */
export function resetMemorySessions(): void {
  memorySessions.clear();
}
