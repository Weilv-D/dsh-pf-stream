/**
 * 会话状态（SessionState / StreamCursor / LRU 管理）。
 *
 * M1 范围：会话聚合骨架与 LRU 上限（2 个视频/会话）；游标快照与 FUnitCache
 * 在 M2/M4 接入（ADR-005 持久化承诺）。持久层（storageDomain）在 M4 接入。
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SessionIntent, SessionState, VideoFingerprint } from '../types.js';

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
export function getVideoSlot(
  state: SessionState,
  fingerprint: VideoFingerprint,
): NonNullable<SessionState['videos'] extends Map<string, infer V> ? V : never> {
  const key = fingerprint.sha256Short;
  const existing = state.videos.get(key);
  if (existing) return existing;
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
  };
  state.videos.set(key, slot);
  return slot;
}
