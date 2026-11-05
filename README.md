# dsh-pf-stream

**中文** | [English](https://github.com/Weilv-D/dsh-pf-stream/blob/main/README.en.md)

让智能体看懂视频：动态抽帧，加上台词。

## 面向使用者

### 能做什么

- **看画面**：画面运动时记录过程，停稳时定格细节；指定时间点可以高清复核。
- **听声音**：有字幕就用字幕；没有字幕时，配置转写引擎后生成台词，并按时间挂到对应画面。
- **按需配置**：不配置转写也能处理画面；配置后可以处理带音轨的视频。

### 安装

1. 确认 `ffmpeg` 与 `ffprobe` 可执行：运行 `ffmpeg -version`。
2. 在 DSH 插件页找到「视频理解」（包名 `dsh-pf-stream`），安装并启用。

首次启用后，插件详情页显示引导卡片。

也可以把安装交给智能体：

```text
安装 DSH 插件 dsh-pf-stream：
1. 用插件管理器从 npm 安装最新版本，结果为 applied 才算成功；
2. 检查 ffmpeg 与 ffprobe；缺失时安装（Windows: winget install Gyan.FFmpeg / macOS: brew install ffmpeg / Linux: sudo apt install ffmpeg）；
3. 对一个本地视频调用 probe；返回时长与分辨率即成功；
4. 汇报插件版本、ffmpeg 位置与检查结果。
```

### 第一次使用：配置转写

打开 **设置 → 插件 → 视频理解**，选一条路线：

| 路线 | 适合 | 操作 |
| --- | --- | --- |
| 本地转写（推荐） | 免费、离线、不填密钥 | 点「下载本地模型」，约 190 MB；下载后点「测试转写」 |
| 云端转写 | 已有 API Key，或机器性能较弱 | 选 OpenAI / Groq / 自定义兼容端点，填入 Key，保存后点「测试转写」 |
| 暂不配置 | 视频都有字幕 | 直接使用；无字幕的语音视频不会生成转写文本 |

判断是否就绪：面板顶部三张状态卡给出 ffmpeg、本地、云端三项结论。「测试转写」成功即代表该链路可用。

默认策略是 `auto`：有可用的云端密钥就用云端，否则用本地引擎。

### 开始使用

对智能体直接提问：

- 「这个视频里发生了什么？」
- 「第 12.9 秒的文字写的是什么？」
- 「每 5 秒抽一帧，看画面怎么变化。」
- 「把这段访谈里说的话按时间整理出来。」

返回示例（节选）：

```text
[Packet #42 | Anchor: #105 | #101(P, 12.1s, Left-Top) → #105(F, 13.4s, Center)]
Audio @Packet #42: [12.1s-12.9s] "这件事我们准备了三年" | [13.0s-13.4s] "今天终于可以说了"
```

文本块是结构化元数据。图像块是每个画布包一张画布。音频部分给出 `status`、来源与逐句时间。

### 遇到问题

| 现象 | 先看这里 |
| --- | --- |
| 提示找不到 ffmpeg | [排障：ffmpeg](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#找不到-ffmpeg) |
| 有声音，但没有台词 | [排障：没有台词](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#有声音但没有台词) |
| 下载模型失败或很慢 | [排障：下载失败](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#下载失败) |
| 转写很慢、超时 | [排障：转写慢](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#转写很慢或超时) |
| 设置页显示「只读」 | [排障：配置只读](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#设置页只读) |

### 使用者文档

- [使用指南](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/使用指南.md)：用法、参数、返回内容、计费、全部配置项
- [排障](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md)：按现象查原因

## 面向开发者

### 组成

- Host 半：工具 `dsh-pf-stream`，包含 `probe`、`pf_stream`、`timestamps`、`uniform` 四个动作；音频边车、本地引擎安装器、设置接口。
- Client 半：`client.js` 在插件详情页注册 `plugins.bundle.config` 与 `plugins.bundle.activation`。

### 返回结构与宿主契约

每个画布包包含 `packet_id`、形态、触发路径、单元时间轴、锚点与条带哈希。音频部分给出 `status`、来源与逐句时间。图像块是画布 PNG。

工具参数使用标准 JSON Schema 根对象。返回值必须是 lossless JSON。附件图像单条消息最多 20 张。运行时依赖只有 `pngjs`。

### 配置与密钥

默认 `engine=auto`。配置通过 `ctx.configEditor.edit()` 写入，保留用户未触碰的字段。密钥通过 `ctx.credentials` 存取，配置文件只保留引用。

### 构建与测试

```bash
pnpm build
pnpm test
pnpm verify:host
pnpm check:package
```

### 开发者文档

- [开发者指南](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/开发者指南.md)：架构、宿主契约、测试与发布
- [Usage Guide](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/usage-guide.md)（English）

## 许可证

Apache-2.0。
