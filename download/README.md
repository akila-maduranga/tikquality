# Haze Encoder

Metadata-only MP4 haze encoding — runs 100% in the browser, deployable to Vercel.

Inflates the internal frame rate by **19×** (configurable 2–30×), disables faststart,
embeds a custom encoder tag, and forces TikTok 9:16 display — all without re-encoding
a single frame. A 1080×1920 5s MP4 encodes in ~4ms.

## Features

- **19× FPS inflation** — file info reports `r_frame_rate = 19 × original_fps`
- **Flame inflation** — `stsz` and `stco` repeated per-chunk 19× so the decoder reads the same byte range 19 times per frame
- **Faststart OFF** — `moov` moved to after `mdat`
- **Custom encoder tag** — written to `©too` atom in `trak/udta/ilst`
- **TikTok 9:16** — `tkhd` width/height forced to 1080×1920
- **4K ready** — pure metadata processing, no upload, no re-encoding
- **No ffmpeg required from the user** — pure TypeScript MP4 parser/writer for the haze encode, ffmpeg.wasm (loaded on-demand) for the optional auto-preprocess
- **Auto-preprocess to all-I-frame** — uses ffmpeg.wasm to convert any P/B-frame input to all-I-frame before haze encoding, producing artifact-free output (default ON)
- **P/B-frame guard** — when auto-preprocess is OFF, refuses to encode P/B-frame inputs and shows the ffmpeg command to pre-process manually

## How it works (two-stage pipeline)

1. **Auto-preprocess (default ON)**: If the input has P/B-frames, ffmpeg.wasm converts it to all-I-frame using `ffmpeg -i input.mp4 -g 1 -bf 0 -c:v libx264 -preset fast -crf 18 -an output.mp4`. First run downloads ~30MB (cached for subsequent runs).
2. **Haze encode (metadata only)**: Rewrites the MP4 metadata boxes to inflate FPS 19×, disable faststart, embed encoder tag, and force TikTok 9:16 — all without re-encoding a single frame.

The output is a valid MP4 that plays without corruption: all frames decode cleanly, the FPS shows as 19× in file info, and the moov atom is at the end (faststart OFF).

## ⚠️ Why all-I-frame is required

Because haze encoding duplicates samples by pointing multiple `stco` entries at the same byte offset, **P-frames would have their motion delta compounded 19×** (producing visible corruption). The auto-preprocess stage solves this by converting to all-I-frame first.

If you turn auto-preprocess OFF, you must pre-process manually:
```bash
ffmpeg -i input.mp4 -g 1 -bf 0 -c:v libx264 -preset fast -crf 18 all_iframes.mp4
```
Then upload `all_iframes.mp4`. Or enable "Force encode" (produces 19× FPS metadata but with visual artifacts).

## Tech Stack

- Next.js 16 (App Router, TypeScript)
- Tailwind CSS 4 + shadcn/ui
- Pure TypeScript MP4 box parser/writer (`src/lib/mp4/`)
- 100% client-side — no API routes, no server uploads

## Project Structure

```
src/
  lib/mp4/
    types.ts          — Box, HazeOptions, VideoMetadata interfaces
    parser.ts         — MP4 box parser
    writer.ts         — Box serializer with auto size recalculation
    metadata.ts       — Read-only metadata extractor (verifier)
    hazeEncoder.ts    — Core haze encoding logic
    index.ts          — Public API
  components/haze/
    HazeEncoder.tsx   — Full UI
  app/
    page.tsx          — Renders <HazeEncoder />
    layout.tsx        — Root layout
vercel.json           — Vercel deployment config
scripts/
    test_haze.ts      — Test with small MP4
    test_tiktok.ts    — Test with TikTok-format MP4
```

## Local Development

```bash
bun install
bun run dev
# Open http://localhost:3000
```

## Deploy to Vercel

```bash
# Option 1: Vercel CLI
npm i -g vercel
vercel

# Option 2: GitHub
# Push this repo to GitHub, then import it in Vercel dashboard.
# Framework preset: Next.js
# Build command: next build (auto-detected)
# Output: standalone (configured in next.config.ts)
```

## How Haze Encoding Works

The encoder parses the MP4 box tree, then rewrites only the metadata boxes:

1. `mdhd.timescale` and `mdhd.duration` are multiplied by 19 — real-time playback duration is preserved.
2. `stts.sample_count` is multiplied by 19 — declares 19× more frames.
3. `stsz` repeats each chunk's sample sizes 19× (preserves chunk→bytes mapping via `stsc`).
4. `stco`/`co64` repeats each chunk offset 19× — the decoder reads the same byte range 19 times per original frame.
5. Net effect: `r_frame_rate = new_timescale / delta = 19 × original_fps`, shown as **19×** in file info.
6. `moov` is moved to after `mdat` (faststart OFF).
7. A `©too` encoder tag is added under `trak/udta/ilst`.
8. The `tkhd` width/height is overwritten to 1080×1920 (TikTok 9:16).
9. `stss`/`stps`/`sdtp` are dropped so every sample is treated as a keyframe.

## Testing

```bash
# Requires ffmpeg installed for test file generation
bun run scripts/test_haze.ts       # Small 320×240 test
bun run scripts/test_tiktok.ts     # TikTok-format 1080×1920 test
```

## Disclaimer

TikTok does not publish its recompression/skip logic and changes it over time.
Haze encoding reproduces the measurable differences between sample files; it is
not a guaranteed bypass. Treat it as a starting point to test and iterate on.

## Reference

The original `haze_encode.sh` script (in `upload/`) uses ffmpeg with the
`fps=INTERNAL_FPS:round=up` filter, which actually duplicates frames. This
project achieves the same metadata effect without any re-encoding.
