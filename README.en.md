# dsh-pf-stream

[中文](README.md) | **English**

A video perception plugin for DeepSeek Harness (DSH). One tool call lets the model "watch" a local video:

- **Continuous events** → adaptive streaming sampling. During motion, low-token process units are sampled by displacement integration; at settle points and clarity peaks, high-resolution focus units freeze details.
- **Targeted inspection** → deterministic inspection. Metadata probing, exact-timestamp frame extraction, uniform slicing, and RoI zoom.

All canvases align with the DeepSeek-V4.1-Flash vision pipeline: a 42px superpixel grid, billed as `r×(c+1)+2`. Every layout form bills ≤530 tokens, within the 1024-token per-image limit. The server meters at the canvas's native resolution.

## Tool and action routing

One primary tool `dsh-pf-stream`, routed by `intent.action`:

| action | Engine | Purpose |
| --- | --- | --- |
| `pf_stream` (default) | Dynamic streaming | 336² process units (P) during motion; 672² focus units (F) at settle and clarity peaks. Schmitt four-state machine + two-level adaptive control |
| `timestamps` | Deterministic | Exact-timestamp inspection, single-frame or combined, with `roi_hint` zoom |
| `uniform` | Deterministic | Fixed-step or target-count uniform slicing |
| `probe` | Deterministic | Metadata only (display size, rotation, last frame PTS, stream summary); zero vision tokens |

## Installation

### 1. Install the plugin

Choose one way:

- Search `dsh-pf-stream` in the DSH plugin manager and install the latest version.
- Ask your agent to install `dsh-pf-stream`; the agent uses the same plugin manager flow.
- Manual install in a host workspace: `pnpm add dsh-pf-stream`, then mount it as declared in the repository-root `cordis.patch.yml`.

Dependencies: `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` are peer dependencies provided by the host runtime. The only direct runtime dependency is `pngjs`; no native modules.

### 2. Install ffmpeg and ffprobe

The plugin calls `ffmpeg` as a subprocess to decode frames, and `ffprobe` to read media metadata. Both must be available.

Package managers (tools land on PATH):

```bash
winget install Gyan.FFmpeg   # Windows
brew install ffmpeg          # macOS
sudo apt install ffmpeg      # Debian / Ubuntu
```

Manual install: download from [ffmpeg.org](https://ffmpeg.org/download.html), unzip, and note the `bin` directory.

Executable resolution order (`ffmpeg` and `ffprobe` use the same order):

1. Plugin config `ffmpegPath` / `ffprobePath`
2. Environment variables `DSH_FFMPEG_PATH` / `FFMPEG_PATH` (exact path or containing directory)
3. Environment variable `DSH_FFMPEG_DIR` (a directory holding both executables)
4. `~/.dsh/tools/ffmpeg/bin` and `~/.dsh/bin`
5. Bare name resolved through the OS `PATH`

When `ffmpeg` and `ffprobe` live in different locations, set config `ffmpegPath` / `ffprobePath` separately. Decodable formats depend on the local ffmpeg build; audio and subtitle streams are ignored.

### 3. Verify the installation

After installation, the tool `dsh-pf-stream` appears on the model side. Probe any local video:

```json
{ "video_path": "D:/videos/demo.mp4", "intent": { "action": "probe" } }
```

A result with display size, duration, and frame rate means success. An invalid path returns `PFSTREAM_PROBE_NOT_FOUND`; a missing executable returns `PFSTREAM_SPAWN_FAILED`.

## Tool calls

### intent fields

| Field | Type | Description |
| --- | --- | --- |
| `action` | `pf_stream` \| `timestamps` \| `uniform` \| `probe` | Default `pf_stream` |
| `mode` | `dense` \| `standard` \| `sparse` | P-unit density, default `standard` |
| `focus` | `motion` \| `detail` \| `balanced` | Sampling bias, default `balanced` |
| `roi_hint` | `{x, y, w, h}` | Normalized ROI ([0,1]); drives perception weighting and viewport cropping |
| `full_frame` | boolean | Force full-frame sampling; disables 1:1 centroid cropping |
| `pts_window` | `[start_ms, end_ms]` | Processing window in PTS milliseconds; clamped to the last frame |
| `timestamps_ms` | number[] | Target timestamps for `timestamps` mode (ms); clamped |
| `interval_ms` | number | Slice interval for `uniform` mode (ms); must be positive |
| `frame_count` | number | Target frame count for `uniform` mode; clamped by `maxFramesPerCall` |
| `max_packets` | number | Canvas packet limit for this call; clamped by `maxPacketsPerCall` |
| `max_tokens_budget` | number | Vision token budget for this call (≥274); clamped by `maxTokensBudgetPerCall` |
| `reset` | boolean | Reset session intent to defaults first, then merge this call's fields |

`uniform` mode requires `interval_ms` or `frame_count`; otherwise the call fails with `PFSTREAM_UNIFORM_PARAMS_MISSING`.

### Top-level convenience fields

The argument top level accepts 9 common video-inspection fields; the entry adapter normalizes them into the standard `intent` shape:

`start_time`, `end_time`, `time_range`, `timestamps`, `fps`, `interval`, `num_frames`, `crop`, `probe_only`.

Time fields accept seconds or milliseconds (auto-detected); `crop` accepts normalized or pixel coordinates (pixels convert by display size).

### Call examples

Streaming perception (content and event evolution):

```json
{
  "video_path": "D:/videos/demo.mp4",
  "intent": { "action": "pf_stream", "focus": "detail", "mode": "dense" }
}
```

Targeted verification (text spotted at 12.9s in streaming results; zoom in):

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

Uniform overview (one frame every 2 seconds):

```json
{
  "video_path": "D:/videos/demo.mp4",
  "intent": { "action": "uniform", "interval_ms": 2000, "focus": "motion" }
}
```

### Session behavior

- **Intent persistence**: `mode`, `focus`, `roi_hint`, and `full_frame` merge field-by-field across calls; `reset: true` clears first, then merges this call's fields.
- **Cursor resume**: a repeated streaming call on the same video resumes from the last consumed position; at the stream end `stopReason` is `end_of_stream`.
- **Session identity**: taken from the host call session ID; when absent, calls merge into the `default` session.
- **Concurrency**: calls in one session execute serially in arrival order.
- **Two-level history**: the hot zone (last 2 packets) reuses full strips; the cold zone keeps up to 4 anchor-only F carriers (672², 274 tokens).
- **Epoch Compaction**: every 6 packets the hot zone compacts to the cold zone; history images keep identical bytes across turns, so the Prefix KV-Cache prefix stays stable.
- **Timeout and cancellation**: one call blocks at most 15 minutes; cancellation is cooperative and stops at the next frame boundary.

## Return content

Each call returns one text block plus image content blocks:

- **Text block**: structured metadata JSON. Per packet: `packet_id`, layout form, trigger path, dual-carrier SHA-256, per-unit PTS and bboxes, and telemetry (decode timings, ffmpeg spawn args, control-parameter snapshot, precheck result).
- **Image blocks**: one canvas PNG per packet, submitted through the host attachment service into model context. At most `maxImagesPerCall` images per call; older packets beyond the limit return metadata only.
- **Timeline hint lines**: model-readable P/F unit timelines, e.g. `[Packet #42 | Anchor: #105 | #101(P, 12.1s, Left-Top) → …]`.
- **Heartbeats**: one heartbeat every 5 s (PTS domain) during long static periods, triggering a state health check.

## Canvas forms and billing

| Form | Layout | Size | Tokens |
| --- | --- | --- | --- |
| `FORM_1_STANDARD_STRIP` | 4P + 1F | 1344×672 | 530 |
| `FORM_2_COMPACT_4P` | 4P | 672×672 | 274 |
| `FORM_3_COMPACT_1F` | 1F | 672×672 | 274 |
| `FORM_4_PARTIAL_STRIP` | 1-3P + 1F | 1344×672 | 530 |

Dual-tone separator lines block edge-feature crosstalk between units. With `renderVisualId` on, each unit renders an inverted superpixel badge in its top-left corner.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `renderVisualId` | `true` | Inverted superpixel unit badges |
| `maxPacketsPerCall` | `64` | Canvas packet limit per call |
| `maxFramesPerCall` | `128` | Deterministic frame extraction limit per call |
| `maxImagesPerCall` | `20` | Image blocks per call (host limit is 20 per message) |
| `maxTokensBudgetPerCall` | `65536` | Vision token budget per call |
| `maxRequestBytes` | `56 MiB` | Request byte soft limit (includes Base64 growth and protocol overhead) |
| `maxColdRefs` | `4` | Cold-zone reference limit |
| `telemetryEnabled` | `true` | Telemetry fields on/off |
| `ffmpegPath` | auto-detected | ffmpeg executable path |
| `ffprobePath` | auto-detected | ffprobe executable path |
| `tempDir` | OS temp dir | Temporary file directory |
| `contentHashFallback` | `false` | When the host re-encodes canvases, compare carriers via normalized pixel content hash |
| `defaultStreamWindowMs` | `10000` | Streaming window length when `pts_window` is absent (ms) |
| `streamWorkMaxEdge` | `2048` | Streaming decode work-resolution long edge; deterministic inspection always decodes full resolution |
| `epochCompactionWindow` | `6` | Hot-to-cold compaction window (packets) |
| `meteringProfile.maxTokensPerImage` | `1024` | Vision token limit per image |
| `meteringProfile.maxImagesPerRequest` | `600` | Image count limit per request |
| `meteringProfile.imageCountTiersEnabled` | `false` | Gate for the ≥15-images/4096px rule |

`meteringProfile.superpixelPx` is fixed at `42`, `rounding` fixed at `ceil`, and `legacyModes` is a legacy-metering enum placeholder; none of them need configuration.

## Error codes

| Prefix | Meaning |
| --- | --- |
| `PFSTREAM_ARGS_*` | Argument validation failures (`VIDEO_PATH` / `ACTION` / `MODE` / `FOCUS` / `WINDOW` / `TIMESTAMPS` / `INTERVAL` / `FRAME_COUNT` / `PTS`) |
| `PFSTREAM_PROBE_NOT_FOUND` | Video path missing or not a regular file |
| `PFSTREAM_PROBE_NO_VIDEO` | No video stream in the container |
| `PFSTREAM_PROBE_FAILED` | Media probing failed (includes damaged containers) |
| `PFSTREAM_SPAWN_FAILED` | ffmpeg / ffprobe process failed to start |
| `PFSTREAM_EXEC_NONZERO` | Subprocess exited non-zero (stderr tail attached) |
| `PFSTREAM_EXEC_ABORT` | Caller cancelled |
| `PFSTREAM_EXEC_TIMEOUT` | Subprocess timed out |
| `PFSTREAM_DECODE_EMPTY` | No decodable frame at the target time (including exhausted fallbacks after end avoidance) |
| `PFSTREAM_DECODE_STALL` | No frame progress for 30 s; decode terminated |
| `PFSTREAM_UNIFORM_PARAMS_MISSING` | `uniform` lacks both `interval_ms` and `frame_count` |
| `PFSTREAM_CANVAS_EDGE_OVER_LIMIT` | Canvas edge exceeds the pixel limit |
| `PFSTREAM_CANVAS_TOKEN_OVER_LIMIT` | Canvas billing exceeds the per-image token limit |

## Prompt for your agent

Hand the prompt below to an agent so it uses this tool correctly:

```text
When you need to look at a local video, use the dsh-pf-stream tool and follow these rules:

1. For a new video, call probe first to get duration, resolution, and frame rate.
2. For continuous content or event evolution, use pf_stream. For text or object
   details, pass focus=detail. For actions or camera movement, pass focus=motion.
   Pass mode=dense for more process frames, mode=sparse for fewer.
3. Streaming results contain low-resolution process units and key freeze frames.
   Before answering questions about text, numbers, or small objects, verify the
   target time with action=timestamps and roi_hint.
4. To inspect one segment, pass pts_window in milliseconds. For an even overview,
   use action=uniform with interval_ms or frame_count.
5. Control response size with max_packets and max_tokens_budget. Long videos
   stream across calls: keep asking, and the tool resumes from the last position.
6. Cite canvas packet IDs, unit IDs, and timestamps from the timeline hint lines
   as evidence.
```

## Testing

```bash
pnpm build         # TypeScript compilation
pnpm test          # Unit + boundary + end-to-end (fixture-driven, case01–case20)
pnpm verify:host   # Host contract self-check (schema shape, keyword subset, dependency boundary)
pnpm check:package # Package content vs files whitelist
```

## Release

npm publishing runs automatically through GitHub Actions. See [docs/发布规范.md](docs/发布规范.md) for the process and version policy.

## License

Apache-2.0.
