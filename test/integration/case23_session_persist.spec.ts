/**
 * 用例 23：会话状态落盘接线（storageDomain，ADR-005 M4）。
 *
 * case05 fixture：调用 1 → 模拟进程重启（关闭领域、清空内存会话，表数据保留，
 * 新设施重新 open 同一张表）→ 调用 2。
 * - 调用 2 从落盘快照恢复：游标续接不重放（包序号跨重启严格递增）；
 * - 意图快照随恢复（intentId 不回退）；
 * - 落盘记录能通过自身 schema 的重新 open（设施互证）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runStreamCallFixture } from './helpers.js';
import { getSessionState, peekSessionState, resetMemorySessions } from '../../src/session/state.js';
import { fingerprintOf, getVideoSlot } from '../../src/session/state.js';
import { fixturePath } from './helpers.js';
import {
  initSessionPersistence,
  sessionPersistenceActive,
  shutdownSessionPersistence,
} from '../../src/session/persistence.js';

const SESSION = 'case23-persist';
const VIDEO = 'case05_motion.mp4';

class FakeTable {
  records = new Map();
  get(key) {
    return this.records.get(key);
  }
  entries() {
    return [...this.records.entries()][Symbol.iterator]();
  }
  async put(key, value) {
    this.records.set(key, value);
  }
  async delete(key) {
    return this.records.delete(key);
  }
}

/** 内存版设施（复刻 facility：open 校验已存记录）。 */
function makeFakeFacility(table) {
  return {
    async open(spec) {
      for (const name of Object.keys(spec.tables)) {
        const schema = spec.tables[name].valueSchema;
        for (const raw of table.records.values()) schema.parse(raw);
      }
      return { name: spec.name, table: () => table, close: async () => {} };
    },
  };
}

beforeEach(async () => {
  resetMemorySessions();
  await shutdownSessionPersistence();
});

afterEach(async () => {
  await shutdownSessionPersistence();
});

describe('case23: 会话状态落盘（storageDomain 接线）', () => {
  it('进程重启后从快照恢复，游标与包序号续接不重放', async () => {
    const table = new FakeTable();
    await initSessionPersistence(makeFakeFacility(table));
    expect(sessionPersistenceActive()).toBe(true);

    // 调用 1：消费 [0, 2000)
    const call1 = await runStreamCallFixture(VIDEO, SESSION, {}, { defaultStreamWindowMs: 2000 });
    expect(table.records.has(SESSION)).toBe(true);
    const cursor1 = call1.nextCursor.lastConsumedPtsMs;
    const maxId1 = Math.max(...call1.packets.map((a) => a.packet.packetId), 0);
    expect(cursor1).toBeGreaterThan(0);

    // 模拟进程重启：关领域 → 内存清空 → 新设施对同一张表重新 open
    await shutdownSessionPersistence();
    resetMemorySessions();
    expect(peekSessionState(SESSION)).toBeUndefined();
    await initSessionPersistence(makeFakeFacility(table));

    // 调用 2：从落盘恢复后继续 [2000, 4000)
    const call2 = await runStreamCallFixture(VIDEO, SESSION, {}, { defaultStreamWindowMs: 2000 });
    // 游标严格前移（等长窗口 fixture 下恢复失败会重放 [0,2000)，cursor2==cursor1）
    expect(call2.nextCursor.lastConsumedPtsMs).toBeGreaterThan(cursor1);

    // 意图快照随恢复：恢复后意图序号不回退（注释宣称的 intentId 不回退落到断言）
    const seqOf = (id: string): number => Number(id.replace('intent_', ''));
    expect(seqOf(call2.sessionIntentId)).toBeGreaterThanOrEqual(seqOf(call1.sessionIntentId));

    // 包序号跨重启连续：增量包（historyMode='initial'）不回退、不重发旧包；
    // 热区/冷区引用按设计复用原包 packetId（full_strip_ref / anchor_only_ref）。
    for (const a of call2.packets) {
      if (a.packet.historyMode !== 'initial') continue;
      expect(a.packet.packetId).toBeGreaterThan(maxId1);
    }
    expect(call2.packets.some((a) => a.packet.historyMode === 'initial')).toBe(true);

    // 恢复后的槽位确实存在（落盘→内存）
    const slot = getVideoSlot(getSessionState(SESSION), fingerprintOf(fixturePath(VIDEO)));
    expect(slot.cursor.lastConsumedPtsMs).toBe(call2.nextCursor.lastConsumedPtsMs);
  }, 240_000);
});
