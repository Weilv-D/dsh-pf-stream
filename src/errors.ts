/**
 * 插件参数化错误。错误码命名空间：PFSTREAM_<模块>_<原因>。
 */

export class PfStreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PfStreamError';
  }
}
