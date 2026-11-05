# dsh-pf-stream

**中文** | [English](README.en.md)

DSH 视频感知插件。智能体用它观看本地视频。画面运动时，插件记录过程。画面停稳时，插件定格细节。指定时间点可以高清检视。

## 安装

前置条件：ffmpeg 与 ffprobe 必须可用。

### 方式一：交给智能体

把下面的提示词交给智能体：

```text
安装 DSH 插件 dsh-pf-stream，按以下步骤执行：
1. 用插件管理器从 npm 安装 dsh-pf-stream 最新版本。安装结果为 applied 才算成功。
2. 检查 ffmpeg 与 ffprobe 是否可用。缺失时安装：
   Windows 用 winget install Gyan.FFmpeg；
   macOS 用 brew install ffmpeg；
   Linux 用 sudo apt install ffmpeg。
3. 对一个本地视频调用 probe。返回时长与分辨率即成功。
4. 汇报插件版本、ffmpeg 位置、验证结果。
```

### 方式二：手动安装

1. 安装 ffmpeg 与 ffprobe：

   ```bash
   winget install Gyan.FFmpeg   # Windows
   brew install ffmpeg          # macOS
   sudo apt install ffmpeg      # Debian / Ubuntu
   ```

2. 可执行文件不在 PATH 时，在插件配置里写 `ffmpegPath` 与 `ffprobePath`。
3. 在宿主环境安装插件包：`pnpm add dsh-pf-stream`。
4. 按包内 `cordis.patch.yml` 写宿主装载配置。
5. 验证：新开 DSH 会话。工具列表出现 `dsh-pf-stream` 即成功。

## 使用

对智能体直接提问：

- 「这个视频里发生了什么？」
- 「第 12.9 秒的文字写的是什么？」
- 「每 5 秒抽一帧，看画面怎么变化。」

参数与返回内容见[使用指南](docs/使用指南.md)。

## 文档

- [使用指南](docs/使用指南.md)
- [Usage Guide](docs/usage-guide.md)
- [发布规范](docs/发布规范.md)

## 许可证

Apache-2.0。
