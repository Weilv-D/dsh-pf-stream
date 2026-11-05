<p align="center">
  <img src="https://raw.githubusercontent.com/Weilv-D/dsh-pf-stream/main/icon.svg" width="72" height="72" alt="Video understanding">
</p>

<h1 align="center">Video understanding</h1>

<p align="center">Frames, motion and speech from a video, aligned on a timeline for the agent.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-pf-stream"><img src="https://img.shields.io/npm/v/dsh-pf-stream?color=2f6feb" alt="npm version"></a>
  <img src="https://img.shields.io/badge/license-Apache--2.0-2ea44f" alt="license">
  <img src="https://img.shields.io/badge/DSH-plugin-6e56cf" alt="DSH plugin">
</p>

<p align="center"><a href="README.md">中文</a> · <b>English</b></p>

---

## Quick start

| Step | Do |
| :--- | :--- |
| 1 | Install ffmpeg ([commands below](#1-install-ffmpeg)); `ffmpeg -version` must print output |
| 2 | Left sidebar **Plugins** → **Video understanding** → switch it on |
| 3 | Click **Download local model** (~190 MB), then **Test transcription** |
| 4 | Give the agent a video path and ask |

Video works without transcription. Only videos that have no subtitles and need speech text require step 3.

## What it does

- **See**: motion is recorded as it happens; the moment it settles, detail is captured. Any timestamp can be inspected at full resolution.
- **Hear**: subtitles are used when present; otherwise a transcription engine produces the speech and mounts it on the matching frames.
- **Optional setup**: video works without transcription; with it, videos that only have a voice track also work.

## Install

### 1. Install ffmpeg

The plugin decodes video with ffmpeg. Check that it runs:

```bash
ffmpeg -version
ffprobe -version
```

Both must print output. If not:

| OS | Command |
| :--- | :--- |
| Windows | `winget install Gyan.FFmpeg` |
| macOS | `brew install ffmpeg` |
| Ubuntu / Debian | `sudo apt install ffmpeg` |

> Open a new terminal and check again. To keep it out of PATH, set `ffmpegPath` and `ffprobePath` in the plugin config.

### 2. Install the plugin in DSH

1. Open DSH and click **Plugins** in the left sidebar.
2. Find **Video understanding** (package `dsh-pf-stream`).
3. Open its detail page and switch it on (top right).
4. On first enable, a setup card appears on the detail page.

If it is not listed, use the install entry on the Plugins page to install `dsh-pf-stream` from npm, then return here.

You can also hand the install to the agent:

```text
Install the DSH plugin dsh-pf-stream:
1. Install the latest version from npm with the plugin manager; success means result applied;
2. Check ffmpeg and ffprobe; install them if missing (Windows: winget install Gyan.FFmpeg / macOS: brew install ffmpeg / Linux: sudo apt install ffmpeg);
3. Call probe on a local video; duration and resolution in the result means success;
4. Report the plugin version, ffmpeg location, and check results.
```

## First run: configure transcription

The transcription engine decides whether videos without subtitles get speech text. Without it, video still works; only the transcript is missing.

To open the settings: **Plugins in the left sidebar → Video understanding → the panel below the description**. Use the same path later to change settings.

Three cards at the top report video decode (ffmpeg), local transcription, and cloud transcription. Pick one path:

| Path | Best for | What to do |
| :--- | :--- | :--- |
| Local (recommended) | Free, offline, no API key | Click "Download local model" (~190 MB), then "Test transcription" |
| Cloud | You have a key, or the machine is slow | Pick OpenAI / Groq / a custom compatible endpoint, paste the key, save, then test |
| Skip for now | Videos have subtitles | Use it as is; speech-only videos get no transcript |

### Local model

1. Click "Download local model". The progress bar shows bytes received; cancel at any time.
2. Clicking again after an interruption resumes the download.
3. When done, the card reads "Ready · whisper.cpp".
4. Click "Test transcription". "Local engine available" means it works.

One-click install currently supports Windows x64. On other systems, install whisper.cpp and set `audio.asr.local.binPath` in the config file, or use cloud transcription.

### Cloud key

1. Choose a provider under "Cloud transcription key".
2. Paste the API key and click "Save". After saving, only "Configured" is shown; the key is never echoed back.
3. Click "Test transcription" to verify the key and network.

> **Auto policy**: cloud is used when key, endpoint and model are all set (faster, billed per use); otherwise the local engine. The badge next to the panel title shows the engine in use, such as "Transcription ready · Cloud". Under "Advanced" you can switch to local only, cloud only, or off.

## Use it

Give the agent a video path and ask:

- "What happens in this video?"
- "What does the text at 12.9 seconds say?"
- "Take one frame every 5 seconds and describe how it changes."
- "Transcribe this interview with timestamps."

Example output (excerpt):

```text
[Packet #42 | Anchor: #105 | #101(P, 12.1s, Left-Top) → #105(F, 13.4s, Center)]
Audio @Packet #42: [12.1s-12.9s] "we prepared this for three years" | [13.0s-13.4s] "today we can finally say it"
```

The text block is structured metadata: each canvas packet reports time, form, anchor, and unit positions; the audio part reports status, source, and per-line timings. The image block is one canvas per packet.

Four ways to look, by question:

| Goal | Ask |
| :--- | :--- |
| Overview first | "Look at this video" — streaming sampling; motion as process, settle as detail |
| One exact moment | "What is written at 12.9s" — deterministic high-resolution frame |
| Even coverage | "One frame every 5 seconds" — uniform sampling |
| A region | "Zoom into the bottom right" — crop by area, then look |

## Design

### Dual-scale streaming perception

Sampling is event-driven rather than fixed-rate. During motion, low-resolution process units (P) record state transitions; at settle, high-resolution freeze units (F) preserve detail. Both are delivered within a single canvas packet, so one observation carries the temporal process and the steady-state result together, and the model need not re-watch a clip to recover a detail.

Density adapts to picture activity: rapid change lowers the sampling rate to suppress redundant frames, while slow change extends the wait until a settle is detected; long static intervals maintain a temporal reference through heartbeats without retransmitting images.

### Canvas packing and metering

Each frame is partitioned on a 42 px superpixel grid; P or F units are selected as needed and assembled into a canvas. A call may carry multiple packets, and each packet contains only the units new relative to the previous one; historical packets collapse into content-hash references, keeping context bounded in long sessions. Metering follows canvas grid cells (`r × (c + 1) + 2`).

### Deterministic inspection

Beyond streaming, four deterministic paths are provided: `probe` parses container metadata only; `timestamps` extracts exact frames at millisecond timestamps; `uniform` samples at a fixed interval; `roi_hint` crops and magnifies a normalized region. None depends on motion detection; outputs are reproducible and suited to verifying text, numerals, and small objects.

### Cascaded speech sources

Speech text is obtained through a three-stage cascade: a sidecar `.srt` / `.vtt` is read first, then embedded soft subtitles; without subtitles, silence detection and a speech-ratio estimate run, and an all-silent video skips transcription; finally ASR runs, either local whisper.cpp or OpenAI / Groq / a custom compatible endpoint. Segments are aligned by PTS and mounted on the corresponding packets, stitched across block boundaries with a ±300 ms tolerance.

The default policy is vision-first with background transcription: once a call exceeds the soft deadline (`graceMs`, 8 s by default), the visual result returns and transcription continues in the background; later calls on the same video hit the disk cache.

### Cold regions in long videos

Historical packets outside the current window collapse into references (anchor hash, time, and transcript text) rather than retransmitting images; a timestamp call restores the detail when needed.

## Troubleshooting

| Symptom | Read |
| :--- | :--- |
| ffmpeg not found | [ffmpeg](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#找不到-ffmpeg) |
| Speech but no transcript | [No transcript](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#有声音但没有台词) |
| Model download fails or is slow | [Download](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#下载失败) |
| Transcription is slow or times out | [Slow transcription](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#转写很慢或超时) |
| Settings page is read-only | [Read-only config](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#设置页只读) |

## Docs

| Document | Contents |
| :--- | :--- |
| [Usage Guide](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/usage-guide.md) | Usage, parameters, output, metering, every config key |
| [使用指南](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/使用指南.md) | Chinese usage guide |
| [排障](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md) | Troubleshooting by symptom (Chinese) |
| [开发者指南](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/开发者指南.md) | Architecture, host contracts, tests, release (Chinese) |

## Development

```bash
pnpm build
pnpm test
pnpm verify:host
pnpm check:package
```

The host half provides the `dsh-pf-stream` tool (`probe` / `pf_stream` / `timestamps` / `uniform`), the audio sidecar, the local engine installer, and the settings API. The client half is `client.js`, which registers the config panel and the setup card on the plugin detail page. The only runtime dependency is `pngjs`.

Configuration is written through `ctx.configEditor.edit()`, which keeps fields the user did not touch; keys live in `ctx.credentials`, and the config file only holds a reference.

## License

Apache-2.0.
