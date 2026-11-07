# dsh-pf-stream Usage Guide

For users and agents: what each call does, which parameters exist, what comes back, and where tokens are spent. Installation and first-run setup live in the [README](../README.en.md); symptom-based fixes in the [troubleshooting guide](排障.md) (Chinese).

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
| `max_tokens_budget` | number | Vision token budget for this call (≥274); clamped by `maxTokensBudgetPerCall`; stops early with a hint line when the next packet would exceed it |
| `audio.mode` | `auto` \| `off` | Audio channel switch for this call; default `auto` |
| `audio.language` | string | Transcription language hint (for example `zh`); default auto-detect |
| `audio.extract_subtitles` | boolean | Whether this probe extracts subtitles (500 segments max; a `truncatedSegments` count is attached beyond that); default follows config |
| `audio.assist_focus` | boolean | Whether this call enables speech-assisted focus; default follows config |
| `reset` | boolean | Reset session intent to defaults first, then merge this call's fields |

`uniform` mode requires `interval_ms` or `frame_count`; otherwise the call fails with `PFSTREAM_UNIFORM_PARAMS_MISSING`.

## Top-level convenience fields

Every `intent` field can also be passed at the top level with the same name: `action`, `mode`, `focus`, `roi_hint`, `full_frame`, `pts_window`, `timestamps_ms`, `interval_ms`, `frame_count`, `max_packets`, `max_tokens_budget`, `reset`, `audio`. When both are present, the value inside `intent` wins.

The top level also accepts 11 historical video-inspection fields; the entry adapter normalizes them into the standard `intent` shape:

`start_time`, `end_time`, `time_range`, `timestamps`, `fps`, `interval`, `num_frames`, `crop`, `bbox`, `roi`, `probe_only`.

Time fields accept seconds or milliseconds (auto-detected); `crop`, `bbox`, and `roi` are equivalent and accept normalized or pixel coordinates (pixels convert by display size).

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

## Audio: where transcripts come from

Three levels, in order; the first success wins:

1. **Subtitles**: a sidecar file next to the video (`demo.mp4` → `demo.zh.srt` / `demo.srt`; multi-tag names like `demo.zh.en.srt` also match, Chinese preferred, then English), or an embedded soft subtitle track. Files decode as UTF-8, with GBK and Big5 fallback detection.
2. **Speech transcription**: with no subtitles, an acoustic VAD runs first (silence short-circuits, so no cost), then the configured engine transcribes.
3. **No speech**: returns `no_audio` instead of failing.

The engine is chosen by `audio.asr.engine`, default `auto`:

| `engine` | Behavior |
| --- | --- |
| `auto` (default) | Cloud when key, endpoint and model are all set (faster, billed per use); otherwise the official voice-input model when ready; otherwise the installed local engine; otherwise no transcription |
| `local` | Official voice-input model when ready; otherwise the local engine |
| `cloud` | Cloud only |
| `host` | Official voice-input model only; no fallback |
| `off` | Transcription off (subtitles are still extracted) |
| `legacy` | 0.2.x semantics: follow the old `audio.asr.provider` values |

The engine in use is shown in the plugin page badge (for example, "Transcription ready · Cloud" or "Transcription ready · Official voice"). Local, cloud and the official voice-input model are configured in the plugin page, not by hand-editing config. Transcript text stays in the original language. If `@deepseek-ai/dsh-experimental-voice-input-bundle` is installed and its SenseVoice model is prepared, the plugin reuses that model; it never downloads or prepares the model itself. The official provider returns text per block with no intra-block timestamps; blocks are at most 15 seconds, so transcript times are block-level. Regional language tags are normalized to the exact provider entry (for example `zh-CN` → `zh`); blank language means auto-detect. A non-`none` legacy `audio.asr.provider` keeps legacy behavior under `engine=auto`; set `engine=host` or clear the legacy provider to reuse the official model. Speech mounts onto the matching packet:

```text
Audio @Packet #42: [12.1s-12.9s] "we spent three years on this" | [13.0s-13.4s] "and today we can finally talk"
```

`audio.status` values: `ok`, `partial` (some chunks failed), `no_audio`, `silent` (audio present but no usable speech), `no_subtitle_asr_unconfigured` (no subtitles and no engine), `disabled`, `timeout_skipped`, `error`. `timeout_skipped` means the visual result returned first; transcription continues in the background and lands in the cache.

## Settings page

**Plugins in the left sidebar → Video understanding → the panel below the description** has three parts:

1. **Status cards**: ffmpeg, local engine, cloud key, and (when installed) official voice input — each with an actionable verdict.
2. **Setup paths**: one-click local model download (progress and cancel), a cloud key (presets plus a custom compatible endpoint), or reuse of the official voice-input model.
3. **Advanced**: engine policy, language, model size, threads, transcript cache usage and clearing.

"Clear transcript cache" removes only the per-file, per-engine transcript JSON; it can be regenerated. Canvas images live in the host attachment store and belong to session history, so this button leaves them alone. Model and engine files are also kept; use "Download local model" again to reinstall.

"Test transcription" runs a real short audio clip through the whole chain, not just a file existence check. In `host` mode, or when `auto`/`local` selects the official provider, the button becomes "Check official voice readiness" and checks only that the official provider is ready; the actual transcription runs when a video is processed.

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
| `audio.cacheDir` | `~/.dsh/cache/dsh-pf-stream` | Root for transcript cache, models and engines (reused per file fingerprint) |
| `audio.graceMs` | `60000` | Transcription soft deadline (ms); visual results return first on timeout |
| `audio.asr.engine` | `auto` | `auto` / `local` / `cloud` / `host` / `off` / `legacy` |
| `audio.asr.preset` | `openai` | Cloud preset: `openai` / `groq` / `custom` |
| `audio.asr.baseUrl` | per preset | Cloud endpoint (OpenAI-compatible) |
| `audio.asr.model` | per preset | Cloud model name; executable path for `local_cli` |
| `audio.asr.apiKey` | empty | Prefer the panel (host credential store); `DSH_ASR_API_KEY` takes priority |
| `audio.asr.language` | auto | Language hint; local engines auto-detect when empty |
| `audio.asr.local.binPath` | managed | Your own local engine executable |
| `audio.asr.local.modelPath` | managed | Your own model file |
| `audio.asr.local.modelId` | `small-q5_1` | Managed model: `base-q5_1` / `small-q5_1` / `medium-q5_0` |
| `audio.asr.local.threads` | `0` | CPU threads; `0` lets the engine decide (cap 16) |
| `audio.asr.local.timeoutMs` | `300000` | Per-chunk local transcription timeout |
| `audio.asr.provider` | `none` | Legacy switch; prefer `engine` |
| `audio.asr.args` | per engine | Advanced `local_cli` template. Tokens: `{audio}`, `{out}`, `{outbase}` (whisper.cpp `-of`), `{dir}` |
| `audio.asr.timeoutMs` | `8000` | Per-chunk cloud transcription timeout |
| `audio.asr.maxConcurrency` | `2` | Concurrency for long-audio chunked transcription |
| `meteringProfile.maxTokensPerImage` | `1024` | Vision token limit per image |
| `meteringProfile.maxImagesPerRequest` | `600` | Image count limit per request |
| `meteringProfile.imageCountTiersEnabled` | `false` | Gate for the ≥15-images/4096px rule |

Executable resolution order (`ffmpeg` and `ffprobe` use the same order): `ffmpegPath`/`ffprobePath` → environment variables `DSH_FFMPEG_PATH`/`FFMPEG_PATH` (exact path or containing directory) → `DSH_FFMPEG_DIR` (a directory holding both executables) → `~/.dsh/tools/ffmpeg/bin` and `~/.dsh/bin` → OS `PATH`.

`meteringProfile.superpixelPx` is fixed at `42`, `rounding` fixed at `ceil`, and `legacyModes` is a legacy-metering enum placeholder; none of them need configuration.

Example: bring your own local engine (already installed whisper-cli / whisper-ctranslate2 / faster-whisper / OpenAI whisper are detected on PATH; this pins them explicitly):

```yaml
audio:
  asr:
    engine: local
    local:
      binPath: C:/tools/whisper/bin/whisper-cli.exe
      modelPath: C:/tools/whisper/models/ggml-small-q5_1.bin
```

Local transcription is timed per chunk; raise `audio.asr.local.timeoutMs` (and `audio.graceMs` for the first call) on slow CPUs. whisper.cpp writes `<outbase>.srt` to the temp directory and the plugin reads it back automatically. Measured on CPU with the small quantized model: 5.3 s for a 7.2 s clip.

## Error codes

| Prefix | Meaning |
| --- | --- |
| `PFSTREAM_ARGS_*` | Argument validation failures (`VIDEO_PATH` / `ACTION` / `MODE` / `FOCUS` / `WINDOW` / `TIMESTAMPS` / `INTERVAL` / `FRAME_COUNT` / `PTS` / `ROI`) |
| `PFSTREAM_PROBE_NOT_FOUND` | Video path missing or not a regular file |
| `PFSTREAM_PROBE_NO_VIDEO` | No video stream in the container |
| `PFSTREAM_PROBE_FAILED` | Media probing failed (includes damaged containers) |
| `PFSTREAM_SPAWN_FAILED` | ffmpeg / ffprobe process failed to start |
| `PFSTREAM_EXEC_NONZERO` | Subprocess exited non-zero (stderr tail attached) |
| `PFSTREAM_EXEC_ABORT` | Caller cancelled |
| `PFSTREAM_EXEC_TIMEOUT` | Subprocess timed out |
| `PFSTREAM_EXEC_OUTPUT_TRUNCATED` | Subprocess stdout exceeded the 64 MiB cap and was truncated |
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
