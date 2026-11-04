/**
 * 内容哈希工具。
 */

import { createHash } from 'node:crypto';

/** 全量 SHA-256，十六进制小写。 */
export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 短指纹哈希（前 16 个十六进制字符），用于 fixture 缓存键等非安全场景。 */
export function shortHash(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16);
}
