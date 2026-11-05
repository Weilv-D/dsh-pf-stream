# dsh-pf-stream

[中文](README.md) | **English**

A DeepSeek Harness (DSH) plugin that lets the agent watch local videos. Sampling follows the picture: motion gets compact process frames, settle points get high-detail freeze frames. Exact timestamps support zoom-in inspection.

## Installation

### Option 1: Ask your agent

Tell your agent:

> Install the DSH plugin dsh-pf-stream from npm, latest version, and make sure ffmpeg is available.

For full control, hand this prompt to your agent:

```text
Install the DSH plugin dsh-pf-stream. Follow these steps:

1. Install the latest dsh-pf-stream package from npm through the plugin manager.
   The install result must be "applied".
2. Check that ffmpeg and ffprobe are available. Install them if missing:
   winget install Gyan.FFmpeg on Windows, brew install ffmpeg on macOS,
   sudo apt install ffmpeg on Linux.
3. Run one probe call on a local video. Duration and resolution in the result
   mean success.
4. Report: plugin version, ffmpeg and ffprobe locations, verification result.
```

### Option 2: Manual install

1. Install ffmpeg and ffprobe. See the [ffmpeg website](https://ffmpeg.org/download.html), or use a package manager:

   ```bash
   winget install Gyan.FFmpeg   # Windows
   brew install ffmpeg          # macOS
   sudo apt install ffmpeg      # Debian / Ubuntu
   ```

   When the executables are not on PATH, set the plugin config `ffmpegPath` and `ffprobePath`.

2. Install and mount the plugin package in the host workspace:

   ```bash
   pnpm add dsh-pf-stream
   ```

   Write the mount entry into the host config as declared in the package's `cordis.patch.yml`.

3. Verify: open a new DSH session; the tool list shows `dsh-pf-stream`. Ask your agent to "look at <video path> with dsh-pf-stream"; a scene description plus canvas images means success.

## Usage

Ask your agent in plain language:

- "What happens in this video?"
- "What does the text at 12.9 s say?"
- "Sample one frame every 5 seconds and describe the changes."

Parameters, return content, and session behavior are covered in the [usage guide](docs/usage-guide.md).

## Documentation

- [Usage guide](docs/usage-guide.md): action routing, parameters, call examples, session behavior, return content, canvas billing, configuration, error codes.
- [Release process](docs/发布规范.md): version policy and release workflow (Chinese).

## License

Apache-2.0.
