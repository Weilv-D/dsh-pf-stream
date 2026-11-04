# dsh-pf-stream

[中文](README.md) | **English**

Video perception plugin for DeepSeek Harness (DSH). One tool lets the model "see" local video files:

- **Continuous events** → adaptive streaming sampling. During motion, the sampler emits low-token process units by displacement integration. On settle or sharpness peaks, it freezes a high-resolution focus unit.
- **Suspicious time points** → deterministic inspection: metadata probe, frame extraction at given timestamps, uniform slicing, and local RoI zoom-in.

Every canvas aligns with the DeepSeek-V4.1-Flash vision pipeline: 42-px superpixel grid, billing `r×(c+1)+2`. All four forms bill ≤530 tokens, within the 1024-token per-image limit. The server encodes each canvas at its original resolution.

## Capability routing

One tool, `dsh-pf-stream`, routes through `intent.action`:

| action | engine | use |
| --- | --- | --- |
| `pf_stream` (default) | adaptive streaming | 336² process units (P) during motion; 672² focus units (F) on settle/peak. Schmitt four-state machine + two-layer adaptation (intent baseline + content feedback R1-R4) |
| `timestamps` | deterministic inspection | high-resolution frames at given timestamps; `roi_hint` zoom-in |
| `uniform` | deterministic inspection | uniform slicing by step or target frame count |
| `probe` | deterministic inspection | metadata only (display size, rotation, last-frame PTS, stream summary); zero vision tokens |

## Install

Requirements:

- DSH host (Node ≥ 20).
- `ffmpeg` and `ffprobe` executables. Search order: plugin config path → `DSH_FFMPEG_PATH` / `FFMPEG_PATH` → `DSH_FFMPEG_DIR` → `~/.dsh/tools/ffmpeg/bin` → `~/.dsh/bin` → `PATH`.

Install the package `dsh-pf-stream` in the DSH plugin manager. The host mounts the plugin through `dsh.bundle.patch` (`cordis.patch.yml`). Peer dependencies `@deepseek-ai/cordis` and `@deepseek-ai/schemastery` resolve in the host runtime. The only runtime dependency is `pngjs`; canvas PNG encoding uses fixed parameters, so output bytes are deterministic.

## Usage

Streaming perception ("what text is on screen"):

```json
{
  "video_path": "D:/videos/demo.mp4",
  "intent": { "action": "pf_stream", "focus": "detail", "mode": "dense" }
}
```

Point inspection (text found at 12.9 s in a streaming result):

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

The top level also accepts common convenience fields from the video-inspection domain: `start_time`, `end_time`, `timestamps`, `fps`, `interval`, `num_frames`, `crop`, `probe_only`. The entry adapter normalizes them into the standard `intent` structure.

## Returned content

Each call returns one or more canvas packets:

- **PNG canvas**: one of four forms (table below). Two-tone separator lines block edge-feature crosstalk between units; an optional superpixel badge renders unit IDs.
- **Structured metadata**: `packet_id`, per-unit PTS, token-grid bbox, source-sampling bbox, dual-carrier SHA-256.
- **Timeline hint line**: a model-readable P/F timeline, for example `[Packet #42 | Anchor: #105 | #101(P, 12.1s, Left-Top) → …]`.

Session capabilities:

- Intent persists across calls.
- Streaming cursor resume: the next call on the same video continues from the last position.
- Two-tier history reference: the hot tier reuses the latest 2 full strips; the cold tier reuses up to 4 independent F-anchor carriers.
- Epoch compaction: hot-to-cold conversion in batches of 6 packets, keeping the multi-turn Prefix KV-Cache prefix stable.

## Canvas and billing

| form | layout | tokens |
| --- | --- | --- |
| `FORM_1_STANDARD_STRIP` | 4P + 1F, 1344×672 | 530 |
| `FORM_2_COMPACT_4P` | 4P, 672×672 | 274 |
| `FORM_3_COMPACT_1F` | 1F, 672×672 | 274 |
| `FORM_4_PARTIAL_STRIP` | 1-3P + 1F, 1344×672 | 530 |

## Configuration

| option | default | description |
| --- | --- | --- |
| `renderVisualId` | `true` | superpixel inverse badge at each unit corner |
| `maxPacketsPerCall` | `64` | packet count limit per call |
| `maxTokensBudgetPerCall` | `65536` | vision-token budget per call |
| `maxRequestBytes` | `56 MiB` | request byte watermark, Base64-inclusive |
| `maxColdRefs` | `4` | cold-tier reference limit |
| `defaultStreamWindowMs` | `10000` | window length in ms when `pts_window` is absent |
| `streamWorkMaxEdge` | `2048` | working-resolution long edge for streaming decode; deterministic inspection always uses full resolution |
| `epochCompactionWindow` | `6` | hot-to-cold batch window, in packets |
| `meteringProfile.imageCountTiersEnabled` | `false` | gate for the ≥15-image 4096-px rule |

## Testing

```bash
pnpm test        # boundary (pure logic) + e2e (fixture-driven), 20 boundary cases
pnpm run build   # TypeScript compile
pnpm verify:host # host-contract self-check (schema shape, keyword subset, dependency boundary)
```

## Release

npm releases run automatically through GitHub Actions. Process and version policy: [docs/发布规范.md](docs/发布规范.md) (Chinese).

## License

Apache-2.0.
