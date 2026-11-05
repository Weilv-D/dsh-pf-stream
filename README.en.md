# dsh-pf-stream

[中文](https://github.com/Weilv-D/dsh-pf-stream/blob/main/README.md) | **English**

Let the agent understand a video: adaptive frame sampling, plus the spoken words.

## For users

### What it does

- **Sees**: records motion as process frames, freezes settles as detail frames, and re-inspects any timestamp at full resolution.
- **Hears**: uses subtitles when present. Otherwise it transcribes speech and mounts each line onto the matching packet.
- **Configures on demand**: video processing works without transcription. Transcription adds speech text for videos with an audio track.

### Install

1. Check ffmpeg and ffprobe: run `ffmpeg -version`.
2. Find **Video understanding** (package `dsh-pf-stream`) on the DSH plugin page. Install and enable it.

A setup card appears on the plugin detail page after the first enable.

Or hand this to the agent:

```text
Install the DSH plugin dsh-pf-stream:
1. Install the latest version from npm with the plugin manager. Only an applied result counts.
2. Check ffmpeg and ffprobe. Install them when missing (Windows: winget install Gyan.FFmpeg; macOS: brew install ffmpeg; Linux: sudo apt install ffmpeg).
3. Call probe on a local video. A returned duration and resolution mean success.
4. Report the plugin version, the ffmpeg location, and the result.
```

### First run: configure transcription

Open **Settings → Plugins → Video understanding**. Pick one path:

| Path | Best for | What to do |
| --- | --- | --- |
| Local transcription (recommended) | Free, offline, no API key | Click "Download local model" (~190 MB), then "Test transcription" |
| Cloud transcription | You have a key, or the machine is slow | Pick OpenAI / Groq / a custom compatible endpoint, paste the key, save, then test |
| Skip for now | Videos have subtitles | Use it as is; speech-only videos get no transcript |

Three status cards report ffmpeg, local, and cloud. A successful "Test transcription" proves the selected path works.

The default policy is `auto`: use a cloud key when present, otherwise use the local engine.

### Use it

Ask the agent:

- "What happens in this video?"
- "What text is shown at 12.9 seconds?"
- "Sample one frame every 5 seconds and describe the change."
- "Transcribe this interview with timestamps."

Sample output (excerpt):

```text
[Packet #42 | Anchor: #105 | #101(P, 12.1s, Left-Top) → #105(F, 13.4s, Center)]
Audio @Packet #42: [12.1s-12.9s] "we spent three years on this" | [13.0s-13.4s] "and today we can finally talk"
```

The text block is structured metadata. Image blocks hold one canvas per packet. The audio part reports `status`, source, and per-line timing.

### Troubleshooting

| Symptom | Where to look |
| --- | --- |
| ffmpeg not found | [ffmpeg](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#找不到-ffmpeg) |
| Speech but no transcript | [No transcript](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#有声音但没有台词) |
| Model download fails or is slow | [Download](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#下载失败) |
| Transcription is slow or times out | [Slow transcription](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#转写很慢或超时) |
| Settings page is read-only | [Read-only config](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md#设置页只读) |

The troubleshooting guide is Chinese-only. UI messages are localized.

### User documentation

- [Usage Guide](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/usage-guide.md) (English)
- [使用指南](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/使用指南.md) (Chinese)
- [排障](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/排障.md) (Chinese)

## For developers

### Components

- Host half: tool `dsh-pf-stream` with `probe`, `pf_stream`, `timestamps`, and `uniform`; audio sidecar; local engine installer; settings API.
- Client half: `client.js` registers `plugins.bundle.config` and `plugins.bundle.activation` on the plugin detail page.

### Output and host contracts

Each canvas packet carries `packet_id`, form, trigger path, unit timeline, and anchor and strip hashes. Image blocks are canvas PNGs.

Tool parameters use a standard JSON Schema root object. Return values must be lossless JSON. One message carries at most 20 attachment images. The only runtime dependency is `pngjs`.

### Configuration and keys

`engine=auto` is the default. Configuration is written through `ctx.configEditor.edit()`, which preserves untouched fields. Keys live in `ctx.credentials`; the config file holds a reference only.

### Build and test

```bash
pnpm build
pnpm test
pnpm verify:host
pnpm check:package
```

### Developer documentation

- [开发者指南](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/开发者指南.md) (Chinese): architecture, host contracts, tests, release
- [Usage Guide](https://github.com/Weilv-D/dsh-pf-stream/blob/main/docs/usage-guide.md) (English)

## License

Apache-2.0.
