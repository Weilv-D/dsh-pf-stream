/**
 * 会话落盘单元测试：storageDomain 接线的模块行为。
 *
 * 假设施复刻宿主 facility 契约（open 时对每条已存记录调 zod .parse），
 * 验证：降级链（无设施/open 失败 no-op）、幂等 init、恢复语义（缺失/已驻留/
 * 损坏 payload/不认识的 schemaVersion）、写读互证（我方记录能过我自己 schema
 * 的重新 open）、保留上限淘汰、shutdown 复位。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_DOMAIN_SPEC,
  ensureSessionPersistenceReady,
  initSessionPersistence,
  persistSession,
  restoreSessionIfAbsent,
  sessionPersistenceActive,
  setSessionDomainForTests,
  setSessionPersistenceLogger,
  shutdownSessionPersistence,
} from '../../../src/session/persistence.js';
import {
  SESSION_MEMORY_LIMIT,
  createSessionState,
  exportSessionSnapshot,
  fingerprintOf,
  getSessionState,
  getVideoSlot,
  peekSessionState,
  resetMemorySessions,
  setMemorySession,
} from '../../../src/session/state.js';
import { fixturePath } from '../../integration/helpers.js';

/** 内存版领域表（结构等价宿主 KvTable 使用面）。 */
class FakeTable {
  records = new Map<string, unknown>();
  openCalls = 0;

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

/**
 * 内存版设施：open 校验已存记录（复刻 facility 行为），可注入失败。
 * spec 的 zod schema 在此处真实执行——验证我方记录能过自身 schema。
 */
function makeFakeFacility(table, opts = {}) {
  return {
    openCalls: 0,
    async open(spec) {
      this.openCalls += 1;
      if (opts.failOpen) throw new Error(opts.failOpen);
      for (const name of Object.keys(spec.tables)) {
        const schema = spec.tables[name].valueSchema;
        for (const [key, raw] of table.records) {
          schema.parse(raw); // 复刻：无效记录在此抛 invalid-record
        }
      }
      return {
        name: spec.name,
        table: () => table,
        close: async () => {},
      };
    },
  };
}

function makeState(sessionId) {
  const state = createSessionState(sessionId);
  const slot = getVideoSlot(state, fingerprintOf(fixturePath('case01_base.mp4')));
  slot.cursor.lastConsumedPtsMs = 12345;
  return state;
}

const warnLog = [];

beforeEach(() => {
  resetMemorySessions();
  setSessionDomainForTests(undefined);
  warnLog.length = 0;
});

afterEach(async () => {
  await shutdownSessionPersistence();
});

describe('降级链', () => {
  it('设施缺失：init 返回 false，操作 no-op，且失败记忆（不重复 open）', async () => {
    const first = await initSessionPersistence(null, { warn: (m) => warnLog.push(m) });
    const again = await initSessionPersistence(undefined);
    expect(first).toBe(false);
    expect(again).toBe(false);
    expect(sessionPersistenceActive()).toBe(false);
    expect(warnLog.some((m) => m.includes('storageDomain 设施不可用'))).toBe(true);
    expect(await persistSession(makeState('s1'))).toBe(false);
    expect(restoreSessionIfAbsent('s1')).toBe(false);
  });

  it('open 失败：init false + 一次告警；冷却期内不重试', async () => {
    const facility = makeFakeFacility(new FakeTable(), { failOpen: 'backend-not-found' });
    expect(await initSessionPersistence(facility, { warn: (m) => warnLog.push(m) })).toBe(false);
    expect(await initSessionPersistence(facility)).toBe(false);
    expect(await ensureSessionPersistenceReady()).toBe(false);
    expect(facility.openCalls).toBe(1);
    expect(warnLog.some((m) => m.includes('落盘已停用'))).toBe(true);
  });

  it('冷却期内换设施：新设施立即重试而非沿用旧冷却', async () => {
    const bad = makeFakeFacility(new FakeTable(), { failOpen: 'backend-a-missing' });
    expect(await initSessionPersistence(bad)).toBe(false);
    const good = makeFakeFacility(new FakeTable());
    expect(await initSessionPersistence(good)).toBe(true);
    expect(good.openCalls).toBe(1);
  });

  it('旧设施 cleanup 不关闭新设施已接管的句柄', async () => {
    const oldFacility = makeFakeFacility(new FakeTable());
    const newFacility = makeFakeFacility(new FakeTable());
    await initSessionPersistence(oldFacility);
    await initSessionPersistence(newFacility);
    await shutdownSessionPersistence(oldFacility);
    expect(sessionPersistenceActive()).toBe(true);
  });

  it('shutdown 复位失败记忆：之后可重新 init', async () => {
    const facility = makeFakeFacility(new FakeTable(), { failOpen: 'x' });
    await initSessionPersistence(facility);
    expect(await initSessionPersistence(facility)).toBe(false);
    await shutdownSessionPersistence();
    const ok = makeFakeFacility(new FakeTable());
    expect(await initSessionPersistence(ok)).toBe(true);
    expect(sessionPersistenceActive()).toBe(true);
  });

  it('已关闭的领域会被 ensure 丢弃并重开', async () => {
    let closed = false;
    const table = new FakeTable();
    const rawGet = table.get.bind(table);
    table.get = (key) => {
      if (closed) {
        const error = new Error('domain closed') as Error & { code: string };
        error.code = 'closed';
        throw error;
      }
      return rawGet(key);
    };
    const facility = makeFakeFacility(table);
    const rawOpen = facility.open.bind(facility);
    facility.open = async (spec) => {
      closed = false;
      return rawOpen(spec);
    };
    await initSessionPersistence(facility);
    closed = true;
    expect(await ensureSessionPersistenceReady()).toBe(true);
    expect(facility.openCalls).toBe(2);
  });

  it('ensure 等待进行中的 open（避免首个调用抢建空会话）', async () => {
    const table = new FakeTable();
    let release!: (handle: unknown) => void;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let openCalls = 0;
    const facility = {
      async open() {
        openCalls += 1;
        await gate;
        return { name: 'pf_stream_sessions', table: () => table, close: async () => {} };
      },
    };
    const initPromise = initSessionPersistence(facility);
    const ensurePromise = ensureSessionPersistenceReady();
    expect(sessionPersistenceActive()).toBe(false);
    release(undefined);
    await expect(initPromise).resolves.toBe(true);
    await expect(ensurePromise).resolves.toBe(true);
    expect(openCalls).toBe(1);
  });
});

describe('写读与恢复语义', () => {
  it('persist→内存清空→restore 重建（游标值一致）', async () => {
    const table = new FakeTable();
    await initSessionPersistence(makeFakeFacility(table));
    const state = makeState('resume-a');
    expect(await persistSession(state)).toBe(true);

    resetMemorySessions(); // 模拟进程重启
    expect(peekSessionState('resume-a')).toBeUndefined();
    expect(restoreSessionIfAbsent('resume-a')).toBe(true);
    const restored = peekSessionState('resume-a');
    expect(restored).toBeDefined();
    const slot = restored.videos.get(state.videos.keys().next().value);
    expect(slot.cursor.lastConsumedPtsMs).toBe(12345);
  });

  it('已驻留内存时不覆盖（restore 幂等）', async () => {
    await initSessionPersistence(makeFakeFacility(new FakeTable()));
    const state = makeState('live');
    setMemorySession(state); // 先驻留内存，再落盘并原地修改
    await persistSession(state);
    state.videos.values().next().value.cursor.lastConsumedPtsMs = 99999;
    // 内存已有该会话 → restore 不动它
    expect(restoreSessionIfAbsent('live')).toBe(false);
    expect(peekSessionState('live').videos.values().next().value.cursor.lastConsumedPtsMs).toBe(99999);
  });

  it('损坏 payload：restore 按无快照处理，不创建会话', async () => {
    const table = new FakeTable();
    await initSessionPersistence(makeFakeFacility(table));
    table.records.set('broken', { schemaVersion: 1, payload: '{not-json', savedAtMs: 1 });
    expect(restoreSessionIfAbsent('broken')).toBe(false);
    expect(peekSessionState('broken')).toBeUndefined();
  });

  it('记录键与 sessionId 不一致：拒绝恢复', async () => {
    const table = new FakeTable();
    await initSessionPersistence(makeFakeFacility(table));
    table.records.set('owner-a', {
      schemaVersion: 1,
      sessionId: 'owner-b',
      payload: '{}',
      savedAtMs: 1,
    });
    expect(restoreSessionIfAbsent('owner-a')).toBe(false);
    expect(peekSessionState('owner-a')).toBeUndefined();
  });

  it('payload 内 sessionId 与请求不一致：拒绝恢复', async () => {
    const table = new FakeTable();
    await initSessionPersistence(makeFakeFacility(table));
    const foreign = makeState('owner-b');
    table.records.set('owner-a', {
      schemaVersion: 1,
      sessionId: 'owner-a',
      payload: exportSessionSnapshot(foreign),
      savedAtMs: 1,
    });
    expect(restoreSessionIfAbsent('owner-a')).toBe(false);
    expect(peekSessionState('owner-a')).toBeUndefined();
  });

  it('写盘遇到 closed 句柄：丢弃重开后重试一次', async () => {
    let closed = false;
    const table = new FakeTable();
    const rawPut = table.put.bind(table);
    table.put = async (key, value) => {
      if (closed) {
        const error = new Error('domain closed') as Error & { code: string };
        error.code = 'closed';
        throw error;
      }
      return rawPut(key, value);
    };
    const facility = makeFakeFacility(table);
    const rawOpen = facility.open.bind(facility);
    facility.open = async (spec) => {
      closed = false;
      return rawOpen(spec);
    };
    await initSessionPersistence(facility);
    closed = true;
    await expect(persistSession(makeState('retry-closed'))).resolves.toBe(true);
    expect(facility.openCalls).toBe(2);
    expect(table.records.has('retry-closed')).toBe(true);
  });

  it('不认识的 schemaVersion：按无快照处理（向前向后兼容）', async () => {
    const table = new FakeTable();
    await initSessionPersistence(makeFakeFacility(table));
    table.records.set('v2', {
      schemaVersion: 2,
      sessionId: 'v2',
      payload: JSON.stringify({ version: 2 }),
      savedAtMs: 1,
    });
    expect(restoreSessionIfAbsent('v2')).toBe(false);
    expect(peekSessionState('v2')).toBeUndefined();
  });

  it('我方写入的记录能通过自身 schema 的重新 open（设施互证）', async () => {
    const table = new FakeTable();
    await initSessionPersistence(makeFakeFacility(table));
    await persistSession(makeState('interop'));
    // 新设施对同一张表 open（zod 校验已存记录），不抛即通过
    const reopened = makeFakeFacility(table);
    await expect(initSessionPersistence(reopened)).resolves.toBe(true);
  });
});

describe('保留上限', () => {
  it('persist 超过 8 个会话后按 savedAtMs 淘汰最旧', async () => {
    const table = new FakeTable();
    await initSessionPersistence(makeFakeFacility(table));
    for (let i = 0; i < 10; i++) {
      const s = makeState(`bulk-${i}`);
      await persistSession(s);
      // savedAtMs 单调 +1ms，保证淘汰顺序确定
      const rec = table.records.get(`bulk-${i}`);
      rec.savedAtMs = 1000 + i;
    }
    expect(table.records.size).toBe(8);
    expect(table.records.has('bulk-0')).toBe(false);
    expect(table.records.has('bulk-1')).toBe(false);
    expect(table.records.has('bulk-9')).toBe(true);
  });
});

describe('内存会话上限', () => {
  it('超过 SESSION_MEMORY_LIMIT 后淘汰最久未触达的会话', () => {
    for (let i = 0; i < SESSION_MEMORY_LIMIT + 2; i += 1) {
      getSessionState(`mem-${i}`);
    }
    expect(peekSessionState('mem-0')).toBeUndefined();
    expect(peekSessionState('mem-1')).toBeUndefined();
    expect(peekSessionState(`mem-${SESSION_MEMORY_LIMIT + 1}`)).toBeDefined();
  });
});

describe('覆盖守卫（回退谱系/未知格式不覆盖磁盘）', () => {
  /** 构造磁盘记录（payload = 真实 exportSessionSnapshot 的 JSON 文本）。 */
  function makeDiskRecord(seq: number, cursor: number, payloadPatch?: (doc: Record<string, unknown>) => void): Record<string, unknown> {
    const state = makeState('guard-session');
    state.packetSeq = seq;
    for (const slot of state.videos.values()) {
      slot.cursor.lastConsumedPtsMs = cursor;
    }
    const payload = JSON.parse(exportSessionSnapshot(state)) as Record<string, unknown>;
    payloadPatch?.(payload);
    return {
      schemaVersion: 1,
      sessionId: 'guard-session',
      payload: JSON.stringify(payload),
      savedAtMs: Date.now(),
    };
  }

  it('磁盘谱系较新（packetSeq 更大）→ 拒绝覆盖并告警一次', async () => {
    const table = new FakeTable();
    const disk = makeDiskRecord(10, 5000);
    table.records.set('guard-session', disk);
    setSessionDomainForTests({ name: 'd', table: () => table, close: async () => {} } as never);
    setSessionPersistenceLogger({ warn: (m) => warnLog.push(m) });

    const state = makeState('guard-session');
    state.packetSeq = 5;
    expect(await persistSession(state)).toBe(false);
    // 磁盘记录未被覆盖（同引用断言，savedAtMs 不参与比较）
    expect(table.records.get('guard-session')).toBe(disk);
    expect(warnLog.some((m) => m.includes('拒绝覆盖'))).toBe(true);
  });

  it('内存谱系不落后（seq/游标均不旧于磁盘）→ 正常覆盖', async () => {
    const table = new FakeTable();
    table.records.set('guard-session', makeDiskRecord(10, 5000));
    setSessionDomainForTests({ name: 'd', table: () => table, close: async () => {} } as never);
    setSessionPersistenceLogger({ warn: (m) => warnLog.push(m) });

    const state = makeState('guard-session');
    state.packetSeq = 10;
    for (const slot of state.videos.values()) slot.cursor.lastConsumedPtsMs = 6000;
    expect(await persistSession(state)).toBe(true);
    expect(warnLog.some((m) => m.includes('拒绝覆盖'))).toBe(false);
  });

  it('packetSeq 相同但磁盘游标更靠前 → 拒绝覆盖', async () => {
    const table = new FakeTable();
    table.records.set('guard-session', makeDiskRecord(10, 9000));
    setSessionDomainForTests({ name: 'd', table: () => table, close: async () => {} } as never);
    setSessionPersistenceLogger({ warn: (m) => warnLog.push(m) });

    const state = makeState('guard-session');
    state.packetSeq = 10;
    for (const slot of state.videos.values()) slot.cursor.lastConsumedPtsMs = 100;
    expect(await persistSession(state)).toBe(false);
    expect(warnLog.some((m) => m.includes('拒绝覆盖'))).toBe(true);
  });

  it('磁盘无记录 → 直接写', async () => {
    const table = new FakeTable();
    setSessionDomainForTests({ name: 'd', table: () => table, close: async () => {} } as never);
    expect(await persistSession(makeState('fresh-session'))).toBe(true);
    expect(table.records.has('fresh-session')).toBe(true);
  });

  it('未来表结构（schemaVersion=2）→ 拒绝覆盖（降级不抹掉新格式）', async () => {
    const table = new FakeTable();
    table.records.set('guard-session', {
      schemaVersion: 2,
      sessionId: 'guard-session',
      payload: '{}',
      savedAtMs: Date.now(),
    });
    setSessionDomainForTests({ name: 'd', table: () => table, close: async () => {} } as never);
    setSessionPersistenceLogger({ warn: (m) => warnLog.push(m) });

    expect(await persistSession(makeState('guard-session'))).toBe(false);
    expect((table.records.get('guard-session') as { schemaVersion: number }).schemaVersion).toBe(2);
  });

  it('payload 无法解析 → 拒绝覆盖', async () => {
    const table = new FakeTable();
    table.records.set('guard-session', {
      schemaVersion: 1,
      sessionId: 'guard-session',
      payload: '{broken',
      savedAtMs: Date.now(),
    });
    setSessionDomainForTests({ name: 'd', table: () => table, close: async () => {} } as never);
    setSessionPersistenceLogger({ warn: (m) => warnLog.push(m) });

    expect(await persistSession(makeState('guard-session'))).toBe(false);
    expect(table.records.get('guard-session')!.payload).toBe('{broken');
  });
});
