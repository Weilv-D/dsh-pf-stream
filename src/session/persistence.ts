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
 *   内部的 SnapshotDoc.version 承载，表结构不因 payload 演进而变；restore 侧拒绝
 *   不认识的 schemaVersion，插件降级不丢记录。
 *
 * 降级链：宿主设施不可用（无存储后端/宿主版本过低）、open 失败、或
 * Config.persistSessionState 关闭时全部操作 no-op——行为回落到进程内内存态
 * （0.3.4 及之前的形态）。
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
/** open 失败后置位：同一插件生命周期内不重试（避免每次调用刷告警）。 */
let initFailed = false;
/** init 时注入的日志出口。 */
let logger: PersistenceLogger | undefined;

const TABLE_NAME = 'snapshots';
/** 保留的会话记录上限：超出按 savedAtMs 从旧到新淘汰（磁盘占用有界）。 */
const PERSISTED_SESSION_LIMIT = 8;

/**
 * 打开领域（幂等）。失败记录一次告警并保持未启用；同一插件生命周期内不重试。
 * 返回落盘是否可用。
 */
export async function initSessionPersistence(
  facility: StorageDomainFacility | undefined | null,
  log?: PersistenceLogger,
): Promise<boolean> {
  if (log !== undefined) logger = log;
  if (domain !== undefined) return true;
  if (initFailed) return false;
  if (opening !== undefined) return opening;
  if (facility === undefined || facility === null || typeof facility.open !== 'function') {
    initFailed = memoizedFailure('storageDomain 设施不可用，会话状态落盘已停用（仅内存态）');
    return false;
  }
  const attempt = (async () => {
    try {
      const opened = await facility.open(SESSION_DOMAIN_SPEC);
      if (opened === undefined || opened === null || typeof opened.table !== 'function') {
        throw new Error('storageDomain.open 返回了非领域句柄');
      }
      domain = opened;
      return true;
    } catch (error) {
      return memoizedFailure(
        `storageDomain 打开领域 '${SESSION_DOMAIN_SPEC.name}' 处置失败，落盘已停用：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      opening = undefined;
    }
  })();
  opening = attempt;
  return attempt;
}

/** 记录一次失败（告警 + 失败记忆），返回 false。 */
function memoizedFailure(message: string): boolean {
  initFailed = true;
  logger?.warn?.(message);
  return false;
}

/** 落盘是否已启用（open 成功）。 */
export function sessionPersistenceActive(): boolean {
  return domain !== undefined;
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
  } catch {
    return false;
  }
  if (!isSnapshotRecord(raw)) return false;
  try {
    setMemorySession(importSessionSnapshot(raw.payload));
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
function isSnapshotRecord(raw: unknown): raw is { schemaVersion: number; payload: string } {
  if (raw === null || typeof raw !== 'object') return false;
  const rec = raw as { schemaVersion?: unknown; payload?: unknown };
  return rec.schemaVersion === 1 && typeof rec.payload === 'string' && rec.payload.length > 0;
}

/**
 * 写入会话快照（put 在后端确认持久后才 resolve，随后执行保留上限淘汰）。
 * 失败不抛出：落盘故障不应使已成功的感知调用报错。
 */
export async function persistSession(state: SessionState): Promise<boolean> {
  if (domain === undefined) return false;
  try {
    await domain.table(TABLE_NAME).put(state.sessionId, {
      schemaVersion: 1,
      sessionId: state.sessionId,
      payload: exportSessionSnapshot(state),
      savedAtMs: Date.now(),
    });
    await pruneSessions(domain.table(TABLE_NAME));
    return true;
  } catch (error) {
    logger?.warn?.(
      `会话 '${state.sessionId}' 快照落盘失败（下次调用重试）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
}

/** 按 savedAtMs 从旧到新淘汰超出 PERSISTED_SESSION_LIMIT 的记录。 */
async function pruneSessions(table: SessionTable): Promise<void> {
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
    try {
      await table.delete(entry.key);
    } catch {
      // 淘汰失败不阻塞主流程（下次 persist 重试）
    }
  }
}

/** 关闭领域并复位模块态（插件 dispose；幂等）。 */
export async function shutdownSessionPersistence(): Promise<void> {
  const d = domain;
  domain = undefined;
  opening = undefined;
  initFailed = false;
  if (d !== undefined) {
    try {
      await d.close();
    } catch {
      // 关闭失败不再抛出（资源销毁路径）
    }
  }
}

/** 测试辅助：直接注入领域句柄（模拟宿主设施已 open 的形态）。 */
export function setSessionDomainForTests(handle: SessionDomainHandle | undefined): void {
  domain = handle;
  opening = undefined;
  initFailed = false;
}
