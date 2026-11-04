/**
 * ffmpeg / ffprobe 可执行文件定位。
 *
 * 解析顺序（先命中先赢）：
 * 1. 插件配置项 ffmpegPath / ffprobePath（精确路径）；
 * 2. 环境变量 DSH_FFMPEG_PATH / FFMPEG_PATH（精确路径或所在目录）；
 * 3. 环境变量 DSH_FFMPEG_DIR（目录，内含 ffmpeg[.exe] / ffprobe[.exe]）；
 * 4. ~/.dsh/tools/ffmpeg/bin 与 ~/.dsh/bin；
 * 5. 裸名 "ffmpeg" / "ffprobe"（交给操作系统 PATH 解析）。
 *
 * macOS 下裸名调用存在定位失败情形，显式路径优先（ADR-006）。
 */

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

export interface BinPaths {
  ffmpeg: string;
  ffprobe: string;
}

const EXE = process.platform === 'win32' ? '.exe' : '';

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 环境变量值既可能是可执行文件路径，也可能是其所在目录；
 * 按两种形态探测目录下的 ffmpeg[.exe] / ffprobe[.exe]。
 */
function resolveFromEnvValue(value: string | undefined, tool: 'ffmpeg' | 'ffprobe'): string | undefined {
  if (!value || value === '') return undefined;
  const toolFile = `${tool}${EXE}`;
  const candidates = [value, join(value, toolFile)];
  // Windows 下环境变量可能不带 .exe 后缀
  if (EXE && isAbsolute(value)) candidates.push(`${value}${EXE}`);
  return candidates.find(isFile);
}

function resolveFromDir(dir: string | undefined, tool: 'ffmpeg' | 'ffprobe'): string | undefined {
  if (!dir || dir === '') return undefined;
  return isFile(join(dir, `${tool}${EXE}`)) ? join(dir, `${tool}${EXE}`) : undefined;
}

export function resolveBinPaths(
  config: { ffmpegPath?: string | undefined; ffprobePath?: string | undefined } = {},
): BinPaths {
  const envDirect = process.env.DSH_FFMPEG_PATH ?? process.env.FFMPEG_PATH;
  const envDir = process.env.DSH_FFMPEG_DIR;
  const home = homedir();
  const homeToolDirs = [join(home, '.dsh', 'tools', 'ffmpeg', 'bin'), join(home, '.dsh', 'bin')];

  const resolveTool = (tool: 'ffmpeg' | 'ffprobe', configured?: string): string => {
    const fromConfig = configured !== undefined && configured !== '' && isFile(configured) ? configured : undefined;
    return (
      fromConfig ??
      resolveFromEnvValue(envDirect, tool) ??
      resolveFromDir(envDir, tool) ??
      homeToolDirs.map((dir) => join(dir, `${tool}${EXE}`)).find(isFile) ??
      tool
    );
  };

  return {
    ffmpeg: resolveTool('ffmpeg', config.ffmpegPath),
    ffprobe: resolveTool('ffprobe', config.ffprobePath),
  };
}
