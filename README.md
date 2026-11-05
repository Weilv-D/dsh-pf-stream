# dsh-pf-stream

**中文** | [English](README.en.md)

DeepSeek Harness（DSH）视频感知插件，让智能体观看本地视频。插件按画面内容自动采样：画面运动时记录过程，画面停稳时定格细节；指定时间点还可以做高清检视。

## 安装

### 方式一：交给智能体

对智能体说：

> 安装 DSH 插件 dsh-pf-stream，从 npm 装最新版本，装完确认 ffmpeg 可用。

需要更完整的控制时，把下面的提示词交给智能体：

```text
安装 DSH 插件 dsh-pf-stream，按以下步骤执行：

1. 用插件管理器从 npm 安装 dsh-pf-stream 最新版本。安装结果为 applied 才算成功。
2. 检查 ffmpeg 与 ffprobe 是否可用。缺失时先安装：
   Windows 用 winget install Gyan.FFmpeg；macOS 用 brew install ffmpeg；
   Linux 用 sudo apt install ffmpeg。
3. 安装后对一个本地视频做一次 probe 调用。返回时长与分辨率即安装成功。
4. 汇报：插件版本、ffmpeg 与 ffprobe 的位置、验证结果。
```

### 方式二：手动安装

1. 安装 ffmpeg 与 ffprobe。安装方法见 [ffmpeg 官网](https://ffmpeg.org/download.html)，或用包管理器：

   ```bash
   winget install Gyan.FFmpeg   # Windows
   brew install ffmpeg          # macOS
   sudo apt install ffmpeg      # Debian / Ubuntu
   ```

   可执行文件不在 PATH 时，用插件配置 `ffmpegPath` 与 `ffprobePath` 指定位置。

2. 宿主环境安装插件包并挂载：

   ```bash
   pnpm add dsh-pf-stream
   ```

   按包内 `cordis.patch.yml` 的声明写入宿主装载配置。

3. 验证：新开 DSH 会话，工具列表出现 `dsh-pf-stream`；对智能体说「用 dsh-pf-stream 看一下 <视频路径>」，返回画面描述与画布图像即安装成功。

## 使用

对智能体直接提问即可：

- 「这个视频里发生了什么？」
- 「第 12.9 秒处的文字写的是什么？」
- 「每 5 秒抽一帧，看看画面怎么变化。」

参数、返回内容与会话行为见[使用指南](docs/使用指南.md)。

## 技术特点

- 画布对齐 42px 超像素网格，按 `r×(c+1)+2` 计费，单包 ≤530 token。
- 双尺度采样：运动过程单元 336²，定格细节单元 672²，由施密特四状态机驱动。
- 确定性检视与流式感知共享同一套画布规范，跨通道输出一致。
- 两级历史引用与 Epoch Compaction：多轮对话中历史图像字节不变，Prefix KV-Cache 前缀稳定。
- 宿主契约自检（`pnpm verify:host`）覆盖 Schema 形态、关键字子集与依赖边界。

## 文档

- [使用指南](docs/使用指南.md)：action 路由、参数、调用示例、会话行为、返回内容、画布计费、配置、错误码。
- [发布规范](docs/发布规范.md)：版本策略与发布流程。

## 许可证

Apache-2.0。
