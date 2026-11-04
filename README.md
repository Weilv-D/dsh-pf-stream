# dsh-pf-stream

DeepSeek Harness（DSH）视频感知插件。模型通过一个工具即可"看"本地视频：

- **连续事件** → 自适应流式采样：运动时按位移积分抽取低 token 过程单元，停稳与顿挫波峰时定格高清焦点单元；
- **可疑时间点** → 确定性检视：元数据探测、指定时间戳抽帧、均匀切片、局部 RoI 放大复核。

全部输出画布对齐 DeepSeek-V4.1-Flash 视觉编码管线：42px 超像素网格、计费 `r×(c+1)+2`、单图 ≤1024 token，不触发服务端二次下采样。

## 能力路由

一个主工具 `dsh-pf-stream`，统一 `intent.action` 路由：

| action | 引擎 | 用途 |
| --- | --- | --- |
| `pf_stream`（默认） | 动态流式采样 | 运动中抽 336² 过程单元（P），停稳/波峰定格 672² 焦点单元（F）；施密特四状态机 + 双层自适应调节（意图基准 + 内容自闭环 R1-R4） |
| `timestamps` | 确定性检视 | 指定时间戳单帧/组合高清检视，支持 `roi_hint` 局部放大 |
| `uniform` | 确定性检视 | 固定步长或目标帧数均匀切片 |
| `probe` | 确定性检视 | 仅元数据（显示宽高/旋转/末帧 PTS/流摘要），零视觉 token |

## 安装

前置条件：

- DSH 宿主（Node ≥ 20）；
- `ffmpeg` 与 `ffprobe` 可执行文件。发现顺序：插件配置路径 → `DSH_FFMPEG_PATH` / `FFMPEG_PATH` → `DSH_FFMPEG_DIR` → `~/.dsh/tools/ffmpeg/bin` → `~/.dsh/bin` → `PATH`。

在 DSH 插件管理器中安装包 `dsh-pf-stream`。宿主经 `dsh.bundle.patch`（`cordis.patch.yml`）挂载插件；peer 依赖 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` 由宿主运行时解析。运行时直接依赖仅 `pngjs`（画布 PNG 编码，参数固定保证字节幂等）。

## 使用

流式感知（问"画面里写了什么"）：

```json
{
  "video_path": "D:/videos/demo.mp4",
  "intent": { "action": "pf_stream", "focus": "detail", "mode": "dense" }
}
```

定点复核（在流式结果中发现 12.9s 处有文字）：

```json
{
  "video_path": "D:/videos/demo.mp4",
  "intent": {
    "action": "timestamps",
    "timestamps_ms": [12900],
    "roi_hint": { "x": 0.2, "y": 0.3, "w": 0.4, "h": 0.4 }
  }
}
```

顶层同时接受视频检视领域常见便捷字段（`start_time` / `end_time` / `timestamps` / `fps` / `interval` / `num_frames` / `crop` / `probe_only`），由入口适配器归一化为标准 `intent` 结构。

## 返回内容

每次调用返回一个或多个画布包：

- **PNG 画布**：四形态之一（见下表），双色隔离线阻断相邻单元边缘串扰，可选超像素角标渲染单元编号；
- **结构化元数据**：`packet_id`、每单元 PTS、token 网格 bbox、源采样 bbox、双载体 SHA-256；
- **时序提示行**：模型可读的 P/F 单元时间轴（如 `[Packet #42 | Anchor: #105 | #101(P, 12.1s, Left-Top) → …]`）。

会话级能力：意图跨调用持久化；同视频流式游标续窗（下次调用从上次位置继续）；两级历史引用（热区最近 2 包整条带复用、冷区至多 4 个 F 锚点独立载体复用）与 Epoch Compaction（默认 6 包窗口）保持多轮对话 Prefix KV-Cache 前缀稳定。

## 画布与计费

| 形态 | 布局 | Token |
| --- | --- | --- |
| `FORM_1_STANDARD_STRIP` | 4P + 1F，1344×672 | 530 |
| `FORM_2_COMPACT_4P` | 4P，672×672 | 274 |
| `FORM_3_COMPACT_1F` | 1F，672×672 | 274 |
| `FORM_4_PARTIAL_STRIP` | 1-3P + 1F，1344×672 | 530 |

## 配置

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `renderVisualId` | `true` | 单元左上角超像素反色角标 |
| `maxPacketsPerCall` | `64` | 单次调用返回包数上限 |
| `maxTokensBudgetPerCall` | `65536` | 单次调用视觉 token 预算 |
| `maxRequestBytes` | `56 MiB` | 请求字节软水位（Base64 后口径） |
| `maxColdRefs` | `4` | 冷区引用上限 |
| `defaultStreamWindowMs` | `10000` | `pts_window` 缺省时窗口长度（毫秒） |
| `streamWorkMaxEdge` | `2048` | 流式解码工作分辨率长边上限（定点检视恒全分辨率） |
| `epochCompactionWindow` | `6` | 热转冷批量收敛窗口（包数） |
| `meteringProfile.imageCountTiersEnabled` | `false` | ≥15 图单边 4096px 规则门控 |

完整配置、设计依据与 20 项工程边界验证方案见 `docs/dsh-pf-stream 技术设计方案.md`。

## 测试

```bash
pnpm test        # boundary（纯逻辑）+ e2e（fixture 驱动），20 项边界用例
pnpm run build   # TypeScript 编译
pnpm verify:host # 宿主契约自检（Schema 形状/关键字子集/依赖边界）
```

## 许可证

Apache-2.0。
