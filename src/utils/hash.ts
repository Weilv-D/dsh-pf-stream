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

/**
 * 规范化像素内容哈希（§6 降级轨）：对解码后的 RGB 像素本身取哈希。
 * 宿主对图像字节重编码（PNG→JPEG/WebP）时字节级 SHA-256 失效，
 * 该哈希在重编码保持像素内容的前提下保持稳定。
 */
export function contentHashOfRgb(width: number, height: number, raw: Uint8Array): string {
  const h = createHash('sha256');
  h.update(`rgb24:${width}x${height}:`);
  h.update(raw);
  return h.digest('hex');
}
