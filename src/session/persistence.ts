/**
 * 会话状态落盘（storageDomain 落盘接线，ADR-005 M4）。
 *
 * 声明领域 `pf_stream_sessions`（表 `snapshots`，键 = sessionId，值 = 会话快照记录），
 * 经宿主 `ctx.storageDomain` 设施打开后持久化 SessionState 快照：pf_stream 每次
 * 成功调用后写一次（put 在后端确认持久后才 resolve），进程重启后同会话首次访问
 * 时从落盘恢复，游标/意图/两级历史跨重启续接。
 *
 * 与宿主设施的耦合面全部鸭子类型：
 * - spec 是平面对象（设施 open 只读 spec 属性并投影为后端 descriptor）；不 import
 *   `@deepseek-ai/dsh-storage-domain`——插件安装形态下宿主包对插件模块是否可解析
 *   未经验证，而 spec 本就是纯数据。
 * - 记录 schema 只被设施调用 `.parse`（open 时逐条校验已存记录）；按 ADR-005 记录
 *   schema 用 zod。spec 声明 `invalidRecords: 'backup-and-skip'`：无法解析的已存
 *   记录由后端移开而不是整个领域打不开。
 * - 记录的 `schemaVersion` 用 z.number() 而非 z.literal(1)：快照格式演进由 payload
 *   内部的 SnapshotDoc.version 承载，表结构不因 payload 演进而变。restore 侧拒绝
 *   不认识的 schemaVersion（按无快照处理）；persist 侧覆盖守卫拒绝覆盖「磁盘谱系
 *   较新或格式未知」的记录——降级后旧版本插件不会用 v1 记录抹掉新版本记录，
 *   设施晚挂载/closed 竞态下回退谱系也不会覆盖磁盘较新快照。
 *
 * 降级链：宿主设施不可用（无存储后端/宿主版本过低）、open 失败、或
 * Config.persistSessionState 关闭时全部操作 no-op——行为回落到进程内内存态
 * （0.3.4 及之前的形态）。
 *
 * 生命周期：
 * - 宿主设施的句柄由调用方持有并负责 close（宿主文档明确要求）；这里把句柄缓存在
 *   模块态，由 `shutdownSessionPersistence()` 在插件卸载时关闭。
 * - 设施被卸载后句柄会变成 closed：`ensureSessionPersistenceReady()` 用一次同步
 *   探活发现并丢弃它；`persistSession` 遇到 `closed` 错误也会丢弃并重开一次。
 * - open 失败后进入 30s 冷却，而不是终身失败；同一失败窗口内只告警一次。
 * - shutdown 递增 generation，令仍在途的 open 结果失效并关闭，避免 dispose 后泄漏。
 */

import { z } from 'zod';
import {
  exportSessionSnapshot,
  importSessionSnapshot,
  peekSessionState,
  setMemorySession,
} from './state.js';
import type { SessionState } from '../types.js';

/** 领域名/表名约束：宿主 UNIT_NAME_RE（^[a-z][a-z0-9_]*$）。 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** 快照记录 schema：payload 为 exportSessionSnapshot 的 JSON 文本。 */
const snapshotRecordSchema = z.object({
  /** 记录结构版本（当前 1）；payload 格式版本由 payload 内部承载。 */
  schemaVersion: z.number(),
  sessionId: z.string(),
  payload: z.string(),
  /** 落盘时间（Date.now()），用于保留上限淘汰。 */
  savedAtMs: z.number(),
});

/** 领域声明（平面对象，形状与宿主 defineDomain 产物一致）。 */
export const SESSION_DOMAIN_SPEC = {
  name: 'pf_stream_sessions',
  version: 1,
  tables: {
    snapshots: { valueSchema: snapshotRecordSchema },
  },
  /** 无法解析的已存记录由后端移开并跳过，不阻塞整个领域打开。 */
  invalidRecords: 'backup-and-skip',
} as const;

// defineDomain 同款装载断言：声明错误在模块加载时大声失败（不依赖宿主包）。
if (!UNIT_NAME_RE.test(SESSION_DOMAIN_SPEC.name)) {
  throw new Error(`domain name '${SESSION_DOMAIN_SPEC.name}' must match ${UNIT_NAME_RE}`);
}
for (const table of Object.keys(SESSION_DOMAIN_SPEC.tables)) {
  if (!UNIT_NAME_RE.test(table)) {
    throw new Error(
      `domain '${SESSION_DOMAIN_SPEC.name}' table '${table}' must match ${UNIT_NAME_RE}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 宿主设施与领域句柄的最小结构类型（运行时鸭子类型，不 import 宿主包）
// ---------------------------------------------------------------------------

/** 领域句柄（宿主 Domain 的使用面子集）。 */
export interface SessionDomainHandle {
  readonly name: string;
  table(name: string): {
    get(key: string): unknown;
    entries(): Iterable<[string, unknown]>;
    put(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<boolean>;
  };
  close(): Promise<void>;
}

/** 宿主 ctx.storageDomain 设施的使用面子集。 */
export interface StorageDomainFacility {
  open(spec: unknown): Promise<SessionDomainHandle>;
}

/** 可选日志（cordis ctx.logger 的使用面子集）。 */
export interface PersistenceLogger {
  warn?(message: string): void;
}

// ---------------------------------------------------------------------------
// 模块态
// ---------------------------------------------------------------------------

/** 已打开的领域（undefined = 落盘未启用）。 */
let domain: SessionDomainHandle | undefined;
/** 进行中的 open（幂等去重）。 */
let opening: Promise<boolean> | undefined;
/** 打开领域用的设施；句柄失效后靠它重开。 */
let facilityRef: StorageDomainFacility | undefined;
/** open 失败后的重试冷却截止时间（ms）。 */
let retryAtMs = 0;
/** 冷却期内不再尝试 open；冷却结束后自动重试。 */
let initFailed = false;
/** 是否已经告警过「设施不可用」（避免每次调用刷日志）。 */
let unavailableWarned = false;
/** 进入新生命周期时递增；在途 open 据此丢弃自己的结果。 */
let generation = 0;
/** init 时注入的日志出口。 */
let logger: PersistenceLogger | undefined;
/** shutdown 后置位：抑制在途 persist 触发的误导性「设施不可用」告警。 */
let shutdownInProgress = false;
/** 已就「回退谱系拒绝覆盖」告警过的会话（每进程每会话至多一次）。 */
const regressWarned = new Set<string>();

const TABLE_NAME = 'snapshots';
/** 保留的会话记录上限：超出按 savedAtMs 从旧到新淘汰（磁盘占用有界）。 */
const PERSISTED_SESSION_LIMIT = 8;
/** open 失败后的重试冷却。 */
const OPEN_RETRY_DELAY_MS = 30_000;
/** 写盘等待上限；超时先返回（写入链继续），避免拖住工具调用。 */
const PERSIST_TIMEOUT_MS = 2_000;
/** 同步探活用的键：只读取，不写入，不会产生记录。 */
const DOMAIN_PROBE_KEY = '\u0000probe';

/**
 * 打开领域（幂等）。失败进入冷却，冷却结束后由下一次调用重试。
 * 返回落盘是否可用。
 */
export async function initSessionPersistence(
  facility: StorageDomainFacility | undefined | null,
  log?: PersistenceLogger,
): Promise<boolean> {
  if (log !== undefined) logger = log;
  if (facility === undefined || facility === null || typeof facility.open !== 'function') {
    warnUnavailable();
    return false;
  }

  // 设施实例变了（例如宿主替换 storageDomain 服务）：旧设施的失败冷却不再适用；
  // 即使当前句柄仍可用，也记住新设施，供旧句柄关闭后重开使用。
  if (facilityRef !== facility) {
    facilityRef = facility;
    initFailed = false;
    retryAtMs = 0;
  }
  // 有效 init 即新生命周期：解除 shutdown 抑制。
  shutdownInProgress = false;

  if (domain !== undefined) {
    if (isDomainUsable(domain)) return true;
    // 设施被卸载/关闭后句柄已不可读：丢弃并由下面的 open 重开。
    domain = undefined;
    initFailed = false;
    retryAtMs = 0;
  }
  if (opening !== undefined) return opening;
  if (initFailed && Date.now() < retryAtMs) return false;

  initFailed = false;
  const attemptGeneration = generation;
  const holder: { promise?: Promise<boolean> } = {};
  const attempt = (async () => {
    // 先让出一次微任务：确保 `opening` 已完成赋值后再进入 open 的同步异常
    // 路径，否则 finally 里的 identity 判断会把刚赋上的 opening 又清掉。
    await Promise.resolve();
    try {
      const opened = await facility.open(SESSION_DOMAIN_SPEC);
      if (opened === undefined || opened === null || typeof opened.table !== 'function') {
        throw new Error('storageDomain.open 返回了非领域句柄');
      }
      if (attemptGeneration !== generation) {
        await closeQuietly(opened);
        return false;
      }
      domain = opened;
      unavailableWarned = false;
      return true;
    } catch (error) {
      if (attemptGeneration !== generation) return false;
      return recordOpenFailure(error);
    } finally {
      if (opening === holder.promise) opening = undefined;
    }
  })();
  holder.promise = attempt;
  opening = attempt;
  return attempt;
}

/** 记录一次 open 失败（冷却 + 告警），返回 false。 */
function recordOpenFailure(error: unknown): boolean {
  initFailed = true;
  retryAtMs = Date.now() + OPEN_RETRY_DELAY_MS;
  logger?.warn?.(
    `storageDomain 打开领域 '${SESSION_DOMAIN_SPEC.name}' 失败，落盘已停用（${Math.round(
      OPEN_RETRY_DELAY_MS / 1000,
    )}s 后重试）：${error instanceof Error ? error.message : String(error)}`,
  );
  return false;
}

/** 设施不可用的告警只发一次（宿主可能完全不提供 storageDomain）。 */
function warnUnavailable(): void {
  if (unavailableWarned || shutdownInProgress) return;
  unavailableWarned = true;
  logger?.warn?.('storageDomain 设施不可用，会话状态落盘已停用（仅内存态）');
}

/** 注入日志出口（index.ts 接线时调用；后续 open 失败/写入失败沿用）。 */
export function setSessionPersistenceLogger(log: PersistenceLogger | undefined): void {
  logger = log;
}

/** 落盘是否已启用（open 成功）。 */
export function sessionPersistenceActive(): boolean {
  return domain !== undefined;
}

/**
 * 在读写前确保领域可用：同步探活已缓存的句柄；失效则丢弃并重开；
 * 有在途 open 时等待它，避免首次调用在 open 完成前建立空会话。
 */
export async function ensureSessionPersistenceReady(): Promise<boolean> {
  if (domain !== undefined) {
    if (isDomainUsable(domain)) return true;
    domain = undefined;
    initFailed = false;
    retryAtMs = 0;
  }
  if (opening !== undefined) return opening;
  if (facilityRef === undefined) {
    warnUnavailable();
    return false;
  }
  if (initFailed && Date.now() < retryAtMs) return false;
  return initSessionPersistence(facilityRef);
}

/** 同步探活：宿主 Domain 在 close 后 get 会抛 DomainError('closed')。 */
function isDomainUsable(handle: SessionDomainHandle): boolean {
  try {
    handle.table(TABLE_NAME).get(DOMAIN_PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * 会话不在内存时从落盘恢复（同步：领域读取取自设施内存态）。
 * 返回是否发生了恢复。恢复失败按无快照处理（下次成功调用会重写落盘）。
 */
export function restoreSessionIfAbsent(sessionId: string): boolean {
  if (domain === undefined) return false;
  if (peekSessionState(sessionId) !== undefined) return false;
  let raw: unknown;
  try {
    raw = domain.table(TABLE_NAME).get(sessionId);
  } catch (error) {
    dropDomainIfClosed(error);
    logger?.warn?.(
      `会话 '${sessionId}' 落盘读取异常（按无快照处理）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  if (!isSnapshotRecord(raw, sessionId)) return false;
  try {
    const restored = importSessionSnapshot(raw.payload);
    if (restored.sessionId !== sessionId) {
      logger?.warn?.(
        `会话 '${sessionId}' 的落盘快照 sessionId 不匹配（记录为 '${restored.sessionId}'），按无快照处理`,
      );
      return false;
    }
    setMemorySession(restored);
    return true;
  } catch (error) {
    logger?.warn?.(
      `会话 '${sessionId}' 的落盘快照无法重建（按无快照处理，下次调用将重写）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/** 领域表句柄的使用面（与宿主 KvTable 的读写面结构等价）。 */
export interface SessionTable {
  get(key: string): unknown;
  entries(): Iterable<[string, unknown]>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

/** 落盘记录形态守卫（restore 侧再校验；schemaVersion 不认识时按无快照处理）。 */
function isSnapshotRecord(
  raw: unknown,
  expectedSessionId: string,
): raw is { schemaVersion: number; sessionId: string; payload: string } {
  if (raw === null || typeof raw !== 'object') return false;
  const rec = raw as { schemaVersion?: unknown; sessionId?: unknown; payload?: unknown };
  return (
    rec.schemaVersion === 1 &&
    rec.sessionId === expectedSessionId &&
    typeof rec.payload === 'string' &&
    rec.payload.length > 0
  );
}

/**
 * 写入会话快照（put 在后端确认持久后才 resolve，随后执行保留上限淘汰）。
 * 失败不抛出：落盘故障不应使已成功的感知调用报错。
 *
 * 写入本身可能因后端慢而超过 PERSIST_TIMEOUT_MS：此时先返回本次调用，
 * 写入链继续在后台完成；下一次 persist 会重新写一份（幂等覆盖）。
 */
export async function persistSession(state: SessionState): Promise<boolean> {
  const write = performPersist(state).catch((error: unknown) => {
    logger?.warn?.(
      `会话 '${state.sessionId}' 快照落盘异常（下次调用重试）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      logger?.warn?.(
        `会话 '${state.sessionId}' 快照落盘超过 ${PERSIST_TIMEOUT_MS}ms，本次调用先返回（写入继续）`,
      );
      resolve(false);
    }, PERSIST_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([write, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 覆盖守卫：磁盘记录的谱系必须不新于内存态才允许覆盖。
 *
 * 设施晚挂载/closed 竞态下，内存会话可能从空游标重建（恢复落空），直接 put
 * 会用回退谱系覆盖磁盘上较新的快照——重启后重复消费 [旧游标, 回退点) 区间。
 * 因此写入前对比会话级单调序号（packetSeq 主键）与全槽位最大游标（次键，
 * 无包轮次只推进游标）：磁盘较新则拒绝覆盖；磁盘记录不认识（schemaVersion≠1、
 * payload 解析失败、快照版本更新）同样拒绝——宁可磁盘保留旧成功点，也不用
 * 回退谱系抹掉未知格式（同时兜住插件降级场景：新版本格式不会被 v1 记录覆盖）。
 */
function mayOverwriteSnapshot(raw: unknown, state: SessionState): boolean {
  if (raw === undefined || raw === null) return true;
  const sessionId = state.sessionId;
  const warn = (reason: string): void => {
    if (regressWarned.has(sessionId)) return;
    regressWarned.add(sessionId);
    logger?.warn?.(`会话 '${sessionId}' ${reason}`);
  };
  if (typeof raw !== 'object') {
    warn('磁盘快照记录形态异常，已跳过本次落盘（保留磁盘原记录）');
    return false;
  }
  const rec = raw as { schemaVersion?: unknown; payload?: unknown };
  if (rec.schemaVersion !== 1) {
    warn(`磁盘快照 schemaVersion=${String(rec.schemaVersion)} 非本版本可写格式，已跳过本次落盘`);
    return false;
  }
  if (typeof rec.payload !== 'string') {
    warn('磁盘快照 payload 形态异常，已跳过本次落盘（保留磁盘原记录）');
    return false;
  }
  let doc: {
    version?: unknown;
    packetSeq?: unknown;
    videos?: Array<[string, { lastConsumedPtsMs?: unknown }]>;
  };
  try {
    doc = JSON.parse(rec.payload);
  } catch {
    warn('磁盘快照 payload 无法解析，已跳过本次落盘（保留磁盘原记录）');
    return false;
  }
  if (doc.version !== 1) {
    warn(`磁盘快照版本 ${String(doc.version)} 非本版本可写格式，已跳过本次落盘`);
    return false;
  }
  let diskCursor = 0;
  if (Array.isArray(doc.videos)) {
    for (const pair of doc.videos) {
      // 导出形态的槽位是扁平结构（cursor 字段直接在槽位上，无 cursor 包裹层）
      const cursor = pair?.[1]?.lastConsumedPtsMs;
      if (typeof cursor === 'number' && cursor > diskCursor) diskCursor = cursor;
    }
  }
  let memCursor = 0;
  for (const slot of state.videos.values()) {
    if (slot.cursor.lastConsumedPtsMs > memCursor) memCursor = slot.cursor.lastConsumedPtsMs;
  }
  const diskSeq = typeof doc.packetSeq === 'number' ? doc.packetSeq : 0;
  if (diskSeq > state.packetSeq || (diskSeq === state.packetSeq && diskCursor > memCursor)) {
    warn(
      `磁盘快照谱系较新（磁盘 packetSeq=${diskSeq}/游标 ${diskCursor}，内存 packetSeq=${state.packetSeq}/游标 ${memCursor}），拒绝覆盖——会话内存态疑似回退（设施晚挂载或恢复落空）`,
    );
    return false;
  }
  return true;
}

async function performPersist(state: SessionState): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (domain === undefined) {
      const ready = await ensureSessionPersistenceReady();
      if (!ready) return false;
    }
    const current = domain;
    if (current === undefined) return false;
    try {
      const table = current.table(TABLE_NAME);
      // 覆盖守卫：回退谱系/未知格式不覆盖（见 mayOverwriteSnapshot）。
      const existing = table.get(state.sessionId);
      if (!mayOverwriteSnapshot(existing, state)) return false;
      await table.put(state.sessionId, {
        schemaVersion: 1,
        sessionId: state.sessionId,
        payload: exportSessionSnapshot(state),
        savedAtMs: Date.now(),
      });
      await pruneSessions(table, state.sessionId);
      return true;
    } catch (error) {
      if (attempt === 0 && dropDomainIfClosed(error)) continue;
      logger?.warn?.(
        `会话 '${state.sessionId}' 快照落盘失败（下次调用重试）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
  return false;
}

/**
 * 按 savedAtMs 从旧到新淘汰超出 PERSISTED_SESSION_LIMIT 的记录。
 * `protectedKey`（刚写入的当前会话）永不淘汰——savedAtMs 取自墙钟，
 * 时钟回退时纯排序会把刚写入的记录排进淘汰区（写完立刻被删）。
 */
async function pruneSessions(table: SessionTable, protectedKey?: string): Promise<void> {
  let entries: Array<[string, unknown]>;
  try {
    entries = [...table.entries()];
  } catch {
    return;
  }
  const aged = entries
    .map(([key, value]) => ({
      key,
      savedAtMs:
        value !== null &&
        typeof value === 'object' &&
        typeof (value as { savedAtMs?: unknown }).savedAtMs === 'number'
          ? (value as { savedAtMs: number }).savedAtMs
          : 0,
    }))
    .sort((a, b) => b.savedAtMs - a.savedAtMs);
  for (const entry of aged.slice(PERSISTED_SESSION_LIMIT)) {
    if (protectedKey !== undefined && entry.key === protectedKey) continue;
    try {
      await table.delete(entry.key);
    } catch {
      // 淘汰失败不阻塞主流程（下次 persist 重试）
    }
  }
}

/** 宿主 Domain 关闭后抛 DomainError('closed')；据此丢弃缓存句柄。 */
function dropDomainIfClosed(error: unknown): boolean {
  if (!isClosedError(error)) return false;
  domain = undefined;
  initFailed = false;
  retryAtMs = 0;
  return true;
}

function isClosedError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  return (
    candidate.code === 'closed' ||
    (typeof candidate.message === 'string' && /closed/i.test(candidate.message))
  );
}

async function closeQuietly(handle: SessionDomainHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // 关闭失败不再抛出（资源销毁路径）
  }
}

/** 关闭领域并复位模块态（插件 dispose；幂等）。
 *
 * `expectedFacility` 用于区分「旧设施 effect 的清理」与「新设施已接管」：
 * 服务替换时 cordis 可能先跑新 effect、后跑旧 effect 的 cleanup，旧 cleanup
 * 不应把新设施刚打开的句柄关掉。
 */
export async function shutdownSessionPersistence(
  expectedFacility?: StorageDomainFacility,
): Promise<void> {
  if (
    expectedFacility !== undefined &&
    facilityRef !== undefined &&
    facilityRef !== expectedFacility
  ) {
    return;
  }
  // 令仍在途的 open 结果失效（它会在完成后自行 close）。
  generation += 1;
  const d = domain;
  domain = undefined;
  opening = undefined;
  facilityRef = undefined;
  initFailed = false;
  retryAtMs = 0;
  unavailableWarned = false;
  shutdownInProgress = true;
  regressWarned.clear();
  if (d !== undefined) await closeQuietly(d);
}

/** 测试辅助：直接注入领域句柄（模拟宿主设施已 open 的形态）。 */
export function setSessionDomainForTests(handle: SessionDomainHandle | undefined): void {
  generation += 1;
  domain = handle;
  opening = undefined;
  facilityRef = undefined;
  initFailed = false;
  retryAtMs = 0;
  unavailableWarned = false;
  shutdownInProgress = false;
  regressWarned.clear();
}
