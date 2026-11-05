# dsh-pf-stream Usage Guide

This guide targets host operators and advanced usage. Installation steps live in the [README](../README.en.md).

## Tool and action routing

One primary tool `dsh-pf-stream`, routed by `intent.action`:

| action | Engine | Purpose |
| --- | --- | --- |
| `pf_stream` (default) | Dynamic streaming | 336² process units (P) during motion; 672² focus units (F) at settle and clarity peaks. Schmitt four-state machine + two-level adaptive control |
| `timestamps` | Deterministic | Exact-timestamp inspection, single frame or combined, with `roi_hint` zoom |
| `uniform` | Deterministic | Fixed-step or target-count uniform slicing |
| `probe` | Deterministic | Metadata only (display size, rotation, last frame PTS, stream summary); zero vision tokens |

## intent fields

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
| `audio.mode` | `auto` \| `off` | Audio channel switch for this call; default `auto` |
| `audio.language` | string | Transcription language hint (for example `zh`); default auto-detect |
| `audio.extract_subtitles` | boolean | Whether this probe extracts subtitles; default follows config |
| `audio.assist_focus` | boolean | Whether this call enables speech-assisted focus; default follows config |
| `reset` | boolean | Reset session intent to defaults first, then merge this call's fields |

`uniform` mode requires `interval_ms` or `frame_count`; otherwise the call fails with `PFSTREAM_UNIFORM_PARAMS_MISSING`.

## Top-level convenience fields

The argument top level accepts 9 common video-inspection fields; the entry adapter normalizes them into the standard `intent` shape:

`start_time`, `end_time`, `time_range`, `timestamps`, `fps`, `interval`, `num_frames`, `crop`, `probe_only`.

Time fields accept seconds or milliseconds (auto-detected); `crop` accepts normalized or pixel coordinates (pixels convert by display size).

## Call examples

Streaming perception (content and event evolution):

```json
{
  "video_path": "D:/videos/demo.mp4",
  "intent": { "action": "pf_stream", "focus": "detail", "mode": "dense" }
}
```

Targeted verification (text spotted at 12.9 s in streaming results; zoom in):

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

## Session behavior

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
- **Audio**: when the video carries speech, transcripts mount onto packets at matching times (an `Audio @Packet #N` hint line plus `audio` metadata). Source order: external or embedded subtitles → acoustic VAD plus ASR → skip silently when no speech. Transcript text stays in the original language.
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
| `audio.mode` | `auto` | Audio channel mode (`auto` enabled; `off` disabled) |
| `audio.extractSubtitles` | `true` | Extract embedded or external subtitles on probe |
| `audio.assistFocus` | `true` | Soft focus enhancement at speech-dense pauses |
| `audio.sliceCodec` | `mp3` | Audio slice codec (`mp3` or `opus`) |
| `audio.cacheDir` | `~/.dsh/cache/dsh-pf-stream` | Transcript cache directory (reused per file fingerprint) |
| `audio.graceMs` | `8000` | Transcription soft deadline (ms); visual results return first on timeout |
| `audio.asr.provider` | `none` | Transcription provider (`none` / `openai_verbose` / `openai_basic` / `local_cli`) |
| `audio.asr.baseUrl` | OpenAI official | Transcription endpoint (OpenAI-compatible protocol) |
| `audio.asr.model` | `whisper-1` | Transcription model name |
| `audio.asr.apiKey` | empty | Transcription key; the `DSH_ASR_API_KEY` environment variable takes priority |
| `audio.asr.timeoutMs` | `8000` | Per-chunk transcription timeout (ms) |
| `audio.asr.maxConcurrency` | `2` | Concurrency for long-audio chunked transcription |
| `meteringProfile.maxTokensPerImage` | `1024` | Vision token limit per image |
| `meteringProfile.maxImagesPerRequest` | `600` | Image count limit per request |
| `meteringProfile.imageCountTiersEnabled` | `false` | Gate for the ≥15-images/4096px rule |

Executable resolution order (`ffmpeg` and `ffprobe` use the same order): `ffmpegPath`/`ffprobePath` → environment variables `DSH_FFMPEG_PATH`/`FFMPEG_PATH` (exact path or containing directory) → `DSH_FFMPEG_DIR` (a directory holding both executables) → `~/.dsh/tools/ffmpeg/bin` and `~/.dsh/bin` → OS `PATH`.

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

## Testing

```bash
pnpm build         # TypeScript compilation
pnpm test          # Unit + boundary + end-to-end (fixture-driven, case01–case20)
pnpm verify:host   # Host contract self-check (schema shape, keyword subset, dependency boundary)
pnpm check:package # Package content vs files whitelist
```
