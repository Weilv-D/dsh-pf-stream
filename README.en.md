# dsh-pf-stream

[中文](README.md) | **English**

A video plugin for DeepSeek Harness (DSH). The agent uses it to watch local videos. During motion, the plugin records the process. At settle, it captures detail frames. Exact timestamps support full-resolution inspection.

## Install

Prerequisite: ffmpeg and ffprobe must be available.

### Option 1: delegate to the agent

Give this prompt to the agent:

```text
Install the DSH plugin dsh-pf-stream. Follow these steps:
1. Install the latest dsh-pf-stream from npm with the plugin manager. The result must be "applied".
2. Check ffmpeg and ffprobe. If they are missing, install them:
   Windows: winget install Gyan.FFmpeg;
   macOS: brew install ffmpeg;
   Linux: sudo apt install ffmpeg.
3. Call probe on a local video. A returned duration and resolution means success.
4. Report the plugin version, the ffmpeg location, and the check result.
```

### Option 2: manual install

1. Install ffmpeg and ffprobe:

   ```bash
   winget install Gyan.FFmpeg   # Windows
   brew install ffmpeg          # macOS
   sudo apt install ffmpeg      # Debian / Ubuntu
   ```

2. If the executables are outside PATH, set `ffmpegPath` and `ffprobePath` in the plugin config.
3. Add the package to the host: `pnpm add dsh-pf-stream`.
4. Mount the plugin as declared in `cordis.patch.yml` inside the package.
5. Verify: start a new DSH session. The tool `dsh-pf-stream` appears in the tool list.

## Usage

Ask the agent directly:

- "What happens in this video?"
- "What text is shown at 12.9 seconds?"
- "Sample one frame every 5 seconds and describe the change."

For parameters and return content, see the [usage guide](docs/usage-guide.md).

## Documentation

- [使用指南](docs/使用指南.md) (Chinese)
- [Usage Guide](docs/usage-guide.md) (English)
- [发布规范](docs/发布规范.md) (release process)

## License

Apache-2.0.
