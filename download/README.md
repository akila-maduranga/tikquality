# Haze Encoder

Metadata-only MP4 haze encoding — runs 100% in the browser, deployable to Vercel.

Implements the **Haze Method** metadata exploit: patches the `mvhd` timescale to create a duration mismatch that tricks TikTok's ingest parser into passthrough mode. No re-encoding, no frame duplication, no corruption — works with any input (P-frames, B-frames, HEVC, whatever).

## Two modes

### Header Patch (default, recommended) — the real "Haze Method"

Patches ONLY the `mvhd` (Movie Header) timescale, leaving the media track (`mdhd`, `stts`, `stsz`, `stco`) completely untouched. This creates a duration mismatch between the movie container and the media track — the "lie" that confuses TikTok's parser into passthrough mode.

- ✅ No corruption (video data is 100% untouched)
- ✅ Works with ANY input (P-frames, B-frames, HEVC, AV1)
- ✅ Instant processing (~1ms, no ffmpeg needed)
- ✅ Faststart OFF (moov after mdat)
- ✅ Custom encoder tag
- ✅ TikTok 9:16 dimensions
- ⚠️ FPS in ffprobe stays the same (r_frame_rate comes from mdhd/stts, not mvhd)

### Frame Inflation (original haze_encode.sh method)

Duplicates `stco`/`stsz` entries to physically declare 19× more frames. FPS in ffprobe shows 19×. Requires all-I-frame input (P-frames would compound deltas and corrupt). Can auto-preprocess with ffmpeg.wasm.

## How Header Patch works (the metadata exploit)

```
Original file:
  mvhd.timescale = 1000, mvhd.duration = 2000 → movie duration = 2.0s
  mdhd.timescale = 15360, mdhd.duration = 30720 → media duration = 2.0s

After Header Patch (×19):
  mvhd.timescale = 19000, mvhd.duration = 2000 → movie duration = 0.105s  ← THE LIE
  mdhd.timescale = 15360, mdhd.duration = 30720 → media duration = 2.0s   ← unchanged
```

The mismatch between mvhd (0.105s) and mdhd (2.0s) is what tricks TikTok's ingest parser. The video plays normally because media playback uses mdhd, not mvhd.

## Tech Stack

- Next.js 16 (App Router, TypeScript)
- Tailwind CSS 4 + shadcn/ui
- Pure TypeScript MP4 box parser/writer (`src/lib/mp4/`)
- ffmpeg.wasm (only for Frame Inflation mode's auto-preprocess option)
- 100% client-side — no API routes, no server uploads

## Project Structure

```
src/
  lib/mp4/
    types.ts          — Box, HazeOptions, VideoMetadata, HazeMode
    parser.ts         — MP4 box parser
    writer.ts         — Box serializer
    metadata.ts       — Read-only metadata extractor
    hazeEncoder.ts    — Core: hazeHeaderPatch() + hazeFrameInflation()
    index.ts          — Public API
  hooks/
    use-ffmpeg.ts     — ffmpeg.wasm hook (for Frame Inflation auto-preprocess)
  components/haze/
    HazeEncoder.tsx   — Full UI with mode selector
  app/
    page.tsx          — Renders <HazeEncoder />
vercel.json           — Vercel deployment config (with COOP/COEP headers)
```

## Local Development

```bash
bun install
bun run dev
# Open http://localhost:3000
```

## Deploy to Vercel

```bash
vercel   # or push to GitHub and import on vercel.com
```

## Disclaimer

TikTok does not publish its recompression/skip logic and changes it over time.
Haze encoding reproduces the measurable differences between sample files; it is
not a guaranteed bypass. Treat it as a starting point to test and iterate on.
