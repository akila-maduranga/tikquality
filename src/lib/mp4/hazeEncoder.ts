/**
 * Haze encoder.
 *
 * Performs metadata-level haze encoding on an MP4 file without re-encoding the
 * video/audio data.
 *
 * HEADER PATCH MODE (recommended):
 *   1. Patch mvhd timescale and duration by mult — the "lie" that tricks
 *      TikTok's ingest parser into passthrough mode (non-standard timescale).
 *   2. Patch tkhd/elst durations by mult to keep real-time playback correct.
 *   3. Inflate mdhd timescale and duration by mult for consistent timescale.
 *   4. Inflate sample tables to declare mult× more frames:
 *      - stts sample_count × mult (delta unchanged)
 *      - stco/co64 entries duplicated × mult (each virtual chunk → same data)
 *      - stsz inflated per-chunk (each virtual chunk's sizes match original)
 *      - stsc unchanged (virtual chunks inherit samples_per_chunk)
 *      - stss remap keyframe indices or drop
 *   5. Inflate ctts sample_count × mult (if present).
 *   6. Write encoder tag, handler name, optional TikTok 9:16 dimensions.
 *
 * FRAME INFLATION MODE (original):
 *   Duplicates stco/stsz entries to declare mult× more frames. FPS in ffprobe
 *   shows mult× original. Requires all-I-frame input.
 *
 * @see src/lib/mp4/hazeEncoder.ts — inline comments reference the Python
 *      implementation in inflate_frames_mp4.py for the sample table inflation.
 */

import { Box, HazeOptions } from "./types";
import {
  findChild,
  findVideoTrack,
  parseMP4,
  readU32,
  readU64,
  writeU32,
  writeU64,
} from "./parser";
import {
  makeContainerBox,
  makeLeafBox,
  removeChildren,
  writeMP4,
} from "./writer";

/** Progress callback type. */
export type ProgressCallback = (stage: string, percent: number) => void;

/** Result of haze encoding. */
export interface HazeResult {
  /** The encoded MP4 file as a Uint8Array. */
  output: Uint8Array;
  /** Number of bytes processed. */
  inputSize: number;
  /** Number of bytes produced. */
  outputSize: number;
  /** Time spent encoding in milliseconds. */
  elapsedMs: number;
}

/**
 * Error thrown when the input video has P/B-frames and haze encoding would
 * produce a corrupted output. The user should either:
 *   1. Re-encode the input to all-I-frame first (e.g. with
 *      `ffmpeg -i in.mp4 -g 1 -bf 0 -c:v libx264 out.mp4`), OR
 *   2. Set HazeOptions.forceEncode = true to encode anyway (the metadata will
 *      report the inflated FPS, but the video will have visible artifacts).
 */
export class HazeKeyframeError extends Error {
  /** Total sample count from stts. */
  sampleCount: number;
  /** Keyframe count from stss (or sampleCount if stss is absent). */
  keyframeCount: number;
  /** The ffmpeg command the user can run to pre-process the input. */
  suggestedCommand: string;

  constructor(sampleCount: number, keyframeCount: number) {
    super(
      `Input video has P/B-frames (${keyframeCount} keyframes out of ${sampleCount} samples). ` +
        `Haze encoding duplicates each sample ${"mult"}× — for P-frames, the delta compounds on each duplicate decode, producing visible corruption. ` +
        `Re-encode the input to all-I-frame first: ffmpeg -i input.mp4 -g 1 -bf 0 -c:v libx264 -preset fast -crf 18 all_iframes.mp4`,
    );
    this.name = "HazeKeyframeError";
    this.sampleCount = sampleCount;
    this.keyframeCount = keyframeCount;
    this.suggestedCommand =
      "ffmpeg -i input.mp4 -g 1 -bf 0 -c:v libx264 -preset fast -crf 18 all_iframes.mp4";
  }
}

/**
 * Encode an MP4 file with haze metadata.
 *
 * Dispatches to either `hazeHeaderPatch` (metadata exploit — patches mvhd/mdhd
 * timescales, no sample table duplication, no corruption) or `hazeFrameInflation`
 * (original method — duplicates stco/stsz entries, requires all-I-frame).
 *
 * @param data - The raw bytes of the input MP4 file.
 * @param options - Encoding options.
 * @param onProgress - Optional progress callback.
 * @throws {HazeKeyframeError} when mode is "frame_inflation", the input has
 *   P/B-frames, and options.forceEncode is false.
 */
export async function hazeEncode(
  data: Uint8Array,
  options: HazeOptions,
  onProgress?: ProgressCallback,
): Promise<HazeResult> {
  if (options.mode === "header_patch") {
    return hazeHeaderPatch(data, options, onProgress);
  }
  return hazeFrameInflation(data, options, onProgress);
}

/**
 * Header Patch mode (the real "Haze Method" / metadata exploit).
 *
 * Patches the mvhd (Movie Header) timescale to a non-standard massive value.
 * This is the "lie" that tricks TikTok's ingest parser into passthrough mode:
 * it sees the non-standard timescale, fails to match a standard compression
 * profile, and defaults to passthrough to avoid breaking the file.
 *
 * CRITICAL: We scale BOTH mvhd.timescale AND mvhd.duration by `mult`. This
 * keeps the movie duration correct (duration/timescale is unchanged) so the
 * video plays at full length. The "lie" is the non-standard timescale value
 * itself, NOT a duration mismatch.
 *
 * Sample table inflation duplicates each chunk offset mult times so every
 * virtual chunk points to the same byte range in mdat. stsz is inflated
 * per-chunk to match. This produces clean duplicate frames throughout the
 * video (not garbage at the end). Combined with the mdhd timescale inflation,
 * ffprobe reports mult× the original FPS.
 *
 * Changes:
 *   1. mvhd.timescale × mult AND mvhd.duration × mult → movie duration stays
 *      correct, but timescale is non-standard (the "lie").
 *   2. tkhd/elst durations × mult → track durations match new mvhd timescale.
 *   3. mdhd.timescale × mult AND mdhd.duration × mult → consistent media timescale.
 *   4. stts sample_count × mult, stco entries duplicated × mult, stsz per-chunk.
 *   5. ctts sample_count × mult (if present) for composition time consistency.
 *   6. Encoder tag, handler name, optional TikTok 9:16 dimensions.
 */
async function hazeHeaderPatch(
  data: Uint8Array,
  options: HazeOptions,
  onProgress?: ProgressCallback,
): Promise<HazeResult> {
  const startTime = performance.now();
  const mult = options.multiplier;

  onProgress?.("Parsing MP4 structure", 5);

  // Step 1: Parse top-level boxes
  const boxes = parseMP4(data);
  if (boxes.length === 0) {
    throw new Error("No MP4 boxes found. Is this a valid MP4 file?");
  }

  const ftyp = boxes.find((b) => b.type === "ftyp");
  if (!ftyp) throw new Error("ftyp box not found - not a valid MP4 file.");

  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) throw new Error("moov box not found - cannot process.");

  const mdat = boxes.find((b) => b.type === "mdat");
  if (!mdat) throw new Error("mdat box not found - no media data.");

  onProgress?.("Locating video track", 15);

  // Step 2: Find video track (for encoder tag, handler name, tkhd)
  const videoTrak = findVideoTrack(moov);
  if (!videoTrak) throw new Error("No video track found in moov.");

  const mdia = findChild(videoTrak, "mdia");
  if (!mdia) throw new Error("mdia box not found in video track.");

  // Step 3: Patch mvhd — scale BOTH timescale AND duration by `mult`.
  // This keeps movie duration = duration/timescale unchanged (video plays
  // full length) while making the timescale value non-standard (the "lie"
  // that confuses TikTok's ingest parser).
  onProgress?.("Patching mvhd timescale (the lie)", 30);
  const mvhd = findChild(moov, "mvhd");
  if (mvhd) {
    patchMvhd(mvhd, mult);
  }

  // Step 3.5: Patch ALL tkhd durations — tkhd.duration is in mvhd.timescale
  // units. Since we just scaled mvhd.timescale by `mult`, we must also scale
  // every track's tkhd.duration by `mult` to keep the real-time duration
  // correct. Otherwise ffprobe/players compute track duration as
  // tkhd.duration / new_mvhd.timescale = original_duration / mult, making
  // the video appear mult× shorter (e.g., 2s video shows as 0.105s).
  onProgress?.("Patching track durations", 40);
  for (const trak of moov.children) {
    if (trak.type !== "trak") continue;
    const tkhd = findChild(trak, "tkhd");
    if (tkhd) {
      patchTkhdDuration(tkhd, mult);
    }

    // Also patch elst (Edit List) segment_durations — these are also in
    // mvhd.timescale units. If we don't scale them, the edit list tells the
    // player to only play the first original_duration / new_timescale seconds,
    // truncating the video. This is the sneaky one — most files have an elst
    // with a single entry matching the track duration.
    const edts = findChild(trak, "edts");
    if (edts) {
      const elst = findChild(edts, "elst");
      if (elst) {
        patchElstDurations(elst, mult);
      }
    }
  }

  // Step 3.6: Inflate sample tables to declare mult× more frames.
  // mdhd timescale/duration × mult for consistent media timescale.
  // stts sample_count × mult, stco duplicated × mult (via step 3.7),
  // stsz inflated per-chunk, stsc unchanged.
  onProgress?.("Inflating timescale & sample tables (frame inflation)", 42);
  inflateMdhd(mdia, mult);

  const minf = findChild(mdia, "minf");
  if (!minf) throw new Error("minf box not found in video track.");
  const stbl = findChild(minf, "stbl");
  if (!stbl) throw new Error("stbl box not found in video track.");

  // Inflate sample tables: stts sample_count × mult, stsz per-chunk,
  // stco left for step 3.7 (shift + duplicate), stsc unchanged.
  inflateStblPythonStyle(stbl, mult, options.dropSyncSamples);

  // Inflate ctts if present — not in the original Python script, but needed
  // for composition time consistency when sample_count is multiplied.
  const ctts = findChild(stbl, "ctts");
  if (ctts) inflateCtts(ctts, mult);

  // Step 3.7: Shift AND duplicate stco/co64 chunk offsets.
  // Each original chunk offset is shifted for box reordering AND repeated mult
  // times so every virtual chunk points to the same byte range in mdat.
  onProgress?.("Duplicating chunk offsets", 45);
  const oldMdatOffset = mdat.fileOffset;
  const newMdatOffset = ftyp.fileOffset + ftyp.size;
  const offsetDelta = newMdatOffset - oldMdatOffset;

  {
    const stco = findChild(stbl, "stco");
    if (stco) shiftAndInflateStco(stco, offsetDelta, mult);
    const co64 = findChild(stbl, "co64");
    if (co64) shiftAndInflateCo64(co64, offsetDelta, mult);
  }

  // Step 4: Set encoder tag & handler name
  onProgress?.("Writing encoder tag & handler name", 60);
  let udta = findChild(videoTrak, "udta");
  if (!udta) {
    udta = makeContainerBox("udta", []);
    videoTrak.children.push(udta);
  }
  setEncoderTag(udta, options.encoderTag);

  const hdlr = findChild(mdia, "hdlr");
  if (hdlr) {
    setHandlerName(hdlr, options.handlerName);
  }

  // Step 5: Force TikTok 9:16 dimensions if enabled
  if (options.forceTikTok9x16) {
    const tkhd = findChild(videoTrak, "tkhd");
    if (tkhd) {
      setTkhdDimensions(tkhd, options.tikTokWidth, options.tikTokHeight);
    }
  }

  // Step 6: Reorder boxes — [ftyp] [mdat] [moov] (faststart OFF)
  onProgress?.("Reordering boxes (moov after mdat)", 80);
  const reordered: Box[] = [];
  reordered.push(ftyp);
  reordered.push(mdat);
  for (const b of boxes) {
    if (b.type !== "ftyp" && b.type !== "mdat") {
      reordered.push(b);
    }
  }

  onProgress?.("Serializing output", 95);
  const output = writeMP4(reordered);

  const elapsedMs = performance.now() - startTime;
  onProgress?.("Done", 100);

  return {
    output,
    inputSize: data.length,
    outputSize: output.length,
    elapsedMs,
  };
}

// ============================================================================
// Header patch helper functions
// ============================================================================

/**
 * Patch mvhd (Movie Header Box) by scaling BOTH timescale AND duration by `mult`.
 *
 * This keeps movie duration = duration/timescale UNCHANGED (so the video plays
 * at full length), while making the timescale value non-standard (the "lie"
 * that confuses TikTok's ingest parser into passthrough mode).
 *
 * mvhd v0: 1 byte version, 3 bytes flags, 4 bytes creation, 4 bytes modification,
 *           4 bytes timescale, 4 bytes duration, ...
 * mvhd v1: same but creation/modification/duration are 8 bytes each.
 */
function patchMvhd(mvhd: Box, mult: number): void {
  const p = mvhd.payload;
  if (p.length < 4) return;
  const version = p[0];

  const newPayload = new Uint8Array(p.length);
  newPayload.set(p);

  if (version === 1) {
    // v1 layout: 4 version/flags + 8 creation + 8 modification + 4 timescale + 8 duration
    if (p.length < 32) return;
    // timescale at offset 20 (4 bytes)
    const oldTimescale = readU32(p, 20);
    writeU32(newPayload, 20, oldTimescale * mult);
    // duration at offset 24 (8 bytes) — scale by mult too
    const oldDurationLo = readU32(p, 28);
    const oldDurationHi = readU32(p, 24);
    if (oldDurationHi === 0) {
      const newDuration = oldDurationLo * mult;
      if (newDuration > 0xffffffff) {
        const big = BigInt(oldDurationLo) * BigInt(mult);
        writeU32(newPayload, 24, Number((big >> 32n) & 0xffffffffn));
        writeU32(newPayload, 28, Number(big & 0xffffffffn));
      } else {
        writeU32(newPayload, 24, 0);
        writeU32(newPayload, 28, newDuration);
      }
    } else {
      const big = (BigInt(oldDurationHi) << 32n) | BigInt(oldDurationLo);
      const newBig = big * BigInt(mult);
      writeU32(newPayload, 24, Number((newBig >> 32n) & 0xffffffffn));
      writeU32(newPayload, 28, Number(newBig & 0xffffffffn));
    }
  } else {
    // v0 layout: 4 version/flags + 4 creation + 4 modification + 4 timescale + 4 duration
    if (p.length < 20) return;
    // timescale at offset 12 (4 bytes)
    const oldTimescale = readU32(p, 12);
    writeU32(newPayload, 12, oldTimescale * mult);
    // duration at offset 16 (4 bytes) — scale by mult too
    const oldDuration = readU32(p, 16);
    const newDuration = oldDuration * mult;
    writeU32(newPayload, 16, newDuration <= 0xffffffff ? newDuration : newDuration >>> 0);
  }
  mvhd.payload = newPayload;
}

/**
 * Patch tkhd (Track Header Box) duration by scaling it by `mult`.
 *
 * tkhd.duration is in movie (mvhd) timescale units. When we scale mvhd.timescale
 * by `mult`, we must also scale tkhd.duration by `mult` to keep the real-time
 * track duration correct. Otherwise the track duration becomes
 * original_tkhd_duration / new_mvhd_timescale = original_real_duration / mult,
 * making the video appear mult× shorter.
 *
 * tkhd v0: 4 version/flags + 4 creation + 4 modification + 4 trackID + 4 reserved + 4 duration + ...
 * tkhd v1: 4 version/flags + 8 creation + 8 modification + 4 trackID + 4 reserved + 8 duration + ...
 */
function patchTkhdDuration(tkhd: Box, mult: number): void {
  const p = tkhd.payload;
  if (p.length < 4) return;
  const version = p[0];

  const newPayload = new Uint8Array(p.length);
  newPayload.set(p);

  if (version === 1) {
    // v1: duration at offset 28 (8 bytes), after 4 flags + 8 creation + 8 mod + 4 trackID + 4 reserved
    if (p.length < 36) return;
    const oldDurLo = readU32(p, 32);
    const oldDurHi = readU32(p, 28);
    if (oldDurHi === 0) {
      const newDur = oldDurLo * mult;
      if (newDur > 0xffffffff) {
        const big = BigInt(oldDurLo) * BigInt(mult);
        writeU32(newPayload, 28, Number((big >> 32n) & 0xffffffffn));
        writeU32(newPayload, 32, Number(big & 0xffffffffn));
      } else {
        writeU32(newPayload, 28, 0);
        writeU32(newPayload, 32, newDur);
      }
    } else {
      const big = (BigInt(oldDurHi) << 32n) | BigInt(oldDurLo);
      const newBig = big * BigInt(mult);
      writeU32(newPayload, 28, Number((newBig >> 32n) & 0xffffffffn));
      writeU32(newPayload, 32, Number(newBig & 0xffffffffn));
    }
  } else {
    // v0: duration at offset 20 (4 bytes), after 4 flags + 4 creation + 4 mod + 4 trackID + 4 reserved
    if (p.length < 24) return;
    const oldDuration = readU32(p, 20);
    const newDuration = oldDuration * mult;
    writeU32(newPayload, 20, newDuration <= 0xffffffff ? newDuration : newDuration >>> 0);
  }
  tkhd.payload = newPayload;
}

/**
 * Patch elst (Edit List Box) segment_durations by scaling them by `mult`.
 *
 * elst.segment_duration is in mvhd.timescale units — same as tkhd.duration.
 * When we scale mvhd.timescale by `mult`, we must also scale every
 * segment_duration by `mult` or the edit list will truncate the video to
 * original_duration / new_timescale seconds.
 *
 * elst v0: 4 version/flags + 4 entry_count + N × (4 seg_duration + 4 media_time + 4 rate)
 * elst v1: 4 version/flags + 4 entry_count + N × (8 seg_duration + 8 media_time + 4 rate)
 */
function patchElstDurations(elst: Box, mult: number): void {
  const p = elst.payload;
  if (p.length < 8) return;
  const version = p[0];
  const entryCount = readU32(p, 4);

  const newPayload = new Uint8Array(p.length);
  newPayload.set(p);

  for (let i = 0; i < entryCount; i++) {
    if (version === 1) {
      // v1: seg_duration at offset 8 + i*20 (8 bytes)
      const off = 8 + i * 20;
      if (off + 8 > p.length) break;
      const oldLo = readU32(p, off + 4);
      const oldHi = readU32(p, off);
      if (oldHi === 0) {
        const newDur = oldLo * mult;
        if (newDur > 0xffffffff) {
          const big = BigInt(oldLo) * BigInt(mult);
          writeU32(newPayload, off, Number((big >> 32n) & 0xffffffffn));
          writeU32(newPayload, off + 4, Number(big & 0xffffffffn));
        } else {
          writeU32(newPayload, off, 0);
          writeU32(newPayload, off + 4, newDur);
        }
      } else {
        const big = (BigInt(oldHi) << 32n) | BigInt(oldLo);
        const newBig = big * BigInt(mult);
        writeU32(newPayload, off, Number((newBig >> 32n) & 0xffffffffn));
        writeU32(newPayload, off + 4, Number(newBig & 0xffffffffn));
      }
    } else {
      // v0: seg_duration at offset 8 + i*12 (4 bytes)
      const off = 8 + i * 12;
      if (off + 4 > p.length) break;
      const oldDur = readU32(p, off);
      const newDur = oldDur * mult;
      writeU32(newPayload, off, newDur <= 0xffffffff ? newDur : newDur >>> 0);
    }
  }
  elst.payload = newPayload;
}

/**
 * Shift all chunk offsets in stco by `delta` (without inflating).
 * Used in header_patch mode to fix chunk offsets after box reordering.
 *
 * stco format: 4 bytes version/flags, 4 bytes entry_count,
 *              then entry_count * 4 bytes of 32-bit offsets.
 */
function shiftStco(stco: Box, delta: number): void {
  const p = stco.payload;
  if (p.length < 8) return;
  const entryCount = readU32(p, 4);
  const newPayload = new Uint8Array(p.length);
  newPayload.set(p);
  for (let i = 0; i < entryCount; i++) {
    const off = 8 + i * 4;
    if (off + 4 > p.length) break;
    const oldOffset = readU32(p, off);
    const newOffset = (oldOffset + delta) >>> 0;
    writeU32(newPayload, off, newOffset);
  }
  stco.payload = newPayload;
}

/**
 * Shift all chunk offsets in co64 by `delta` (without inflating).
 * co64 uses 8-byte offsets.
 */
function shiftCo64(co64: Box, delta: number): void {
  const p = co64.payload;
  if (p.length < 8) return;
  const entryCount = readU32(p, 4);
  const newPayload = new Uint8Array(p.length);
  newPayload.set(p);
  const bigDelta = BigInt(delta);
  for (let i = 0; i < entryCount; i++) {
    const off = 8 + i * 8;
    if (off + 8 > p.length) break;
    let offset = readU64(p, off);
    offset = offset + bigDelta;
    if (offset < 0n) offset = 0n;
    writeU64(newPayload, off, offset);
  }
  co64.payload = newPayload;
}

// ============================================================================
// Frame inflation mode (original haze method)
// ============================================================================

/**
 * Frame Inflation mode (original haze method).
 *
 * Duplicates stco/stsz entries to physically declare `mult`× more frames.
 * FPS in ffprobe shows `mult`× the original. Requires all-I-frame input
 * (P-frames would compound deltas and corrupt).
 */
async function hazeFrameInflation(
  data: Uint8Array,
  options: HazeOptions,
  onProgress?: ProgressCallback,
): Promise<HazeResult> {
  const startTime = performance.now();
  const mult = options.multiplier;

  onProgress?.("Parsing MP4 structure", 5);

  // Step 1: Parse top-level boxes
  const boxes = parseMP4(data);
  if (boxes.length === 0) {
    throw new Error("No MP4 boxes found. Is this a valid MP4 file?");
  }

  const ftyp = boxes.find((b) => b.type === "ftyp");
  if (!ftyp) throw new Error("ftyp box not found - not a valid MP4 file.");

  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) throw new Error("moov box not found - cannot process.");

  const mdat = boxes.find((b) => b.type === "mdat");
  if (!mdat) throw new Error("mdat box not found - no media data.");

  onProgress?.("Locating video track", 15);

  // Step 2: Find video track
  const videoTrak = findVideoTrack(moov);
  if (!videoTrak) throw new Error("No video track found in moov.");

  const mdia = findChild(videoTrak, "mdia");
  if (!mdia) throw new Error("mdia box not found in video track.");
  const minf = findChild(mdia, "minf");
  if (!minf) throw new Error("minf box not found in video track.");
  const stbl = findChild(minf, "stbl");
  if (!stbl) throw new Error("stbl box not found in video track.");

  // Step 2.5: Keyframe guard — refuse to encode P/B-frame inputs unless forceEncode is set.
  if (!options.forceEncode) {
    const stts = findChild(stbl, "stts");
    const stss = findChild(stbl, "stss");
    if (stts) {
      const sttsPayload = stts.payload;
      if (sttsPayload.length >= 8) {
        const entryCount = readU32(sttsPayload, 4);
        let sampleCount = 0;
        for (let i = 0; i < entryCount; i++) {
          const off = 8 + i * 8;
          if (off + 8 > sttsPayload.length) break;
          sampleCount += readU32(sttsPayload, off);
        }
        const keyframeCount = stss ? readU32(stss.payload, 4) : sampleCount;
        if (keyframeCount < sampleCount) {
          throw new HazeKeyframeError(sampleCount, keyframeCount);
        }
      }
    }
  }

  // Step 3: Compute mdat offset shift
  const oldMdatOffset = mdat.fileOffset;
  const newMdatOffset = ftyp.fileOffset + ftyp.size;
  const offsetDelta = newMdatOffset - oldMdatOffset;

  onProgress?.("Inflating timescale & sample tables", 30);

  // Step 4: Inflate mdhd timescale and duration
  inflateMdhd(mdia, mult);

  // Step 5: Inflate stts
  const stts = findChild(stbl, "stts");
  if (stts) {
    inflateStts(stts, mult);
  }

  // Step 6: Inflate ctts (if present)
  const ctts = findChild(stbl, "ctts");
  if (ctts) {
    inflateCtts(ctts, mult);
  }

  onProgress?.("Inflating sample sizes", 45);

  // Step 7: Inflate stsz (must be done in conjunction with stsc/stco to preserve
  // chunk→bytes mapping: for each original chunk, repeat its sample sizes mult times)
  const stsz = findChild(stbl, "stsz");
  const stsc = findChild(stbl, "stsc");
  const stco = findChild(stbl, "stco");
  const co64 = findChild(stbl, "co64");
  const chunkCount = stco
    ? readU32(stco.payload, 4)
    : co64
      ? readU32(co64.payload, 4)
      : 0;
  if (stsz && stsc && chunkCount > 0) {
    inflateStszByChunk(stsz, stsc, chunkCount, mult);
  } else if (stsz) {
    // Fallback (no stsc or single chunk): repeat each size mult times
    inflateStsz(stsz, mult);
  }

  onProgress?.("Inflating chunk offsets", 60);

  // Step 8: Shift and inflate stco/co64
  if (stco) {
    shiftAndInflateStco(stco, offsetDelta, mult);
  }
  if (co64) {
    shiftAndInflateCo64(co64, offsetDelta, mult);
  }

  // Step 9: Drop stss if requested (also drop sdtp since its per-sample layout
  // doesn't survive chunk duplication cleanly without stsc coordination).
  if (options.dropSyncSamples) {
    removeChildren(stbl, ["stss", "stps", "sdtp"]);
  } else {
    // Inflate stss: each keyframe K -> mult entries (K-1)*mult+1 .. K*mult
    const stss = findChild(stbl, "stss");
    if (stss) inflateStss(stss, mult);
    // Drop sdtp — its per-sample layout conflicts with chunk duplication
    removeChildren(stbl, ["sdtp"]);
  }

  onProgress?.("Writing encoder tag & handler name", 75);

  // Step 11: Add encoder tag to trak/udta/ilst
  let udta = findChild(videoTrak, "udta");
  if (!udta) {
    udta = makeContainerBox("udta", []);
    videoTrak.children.push(udta);
  }
  setEncoderTag(udta, options.encoderTag);

  // Step 12: Update handler_name in hdlr
  const hdlr = findChild(mdia, "hdlr");
  if (hdlr) {
    setHandlerName(hdlr, options.handlerName);
  }

  // Step 13: Optionally force TikTok 9:16 display in tkhd
  if (options.forceTikTok9x16) {
    const tkhd = findChild(videoTrak, "tkhd");
    if (tkhd) {
      setTkhdDimensions(tkhd, options.tikTokWidth, options.tikTokHeight);
    }
  }

  onProgress?.("Reordering boxes (moov after mdat)", 85);

  // Step 14: Reorder top-level boxes: [ftyp] [mdat] [moov]
  // We need to keep any other top-level boxes (like free, skip) in a sensible place.
  // For simplicity: keep ftyp first, then mdat, then everything else (including moov).
  const reordered: Box[] = [];
  reordered.push(ftyp);
  reordered.push(mdat);
  for (const b of boxes) {
    if (b.type !== "ftyp" && b.type !== "mdat") {
      reordered.push(b);
    }
  }

  onProgress?.("Serializing output", 95);

  // Step 15: Serialize
  const output = writeMP4(reordered);

  const elapsedMs = performance.now() - startTime;
  onProgress?.("Done", 100);

  return {
    output,
    inputSize: data.length,
    outputSize: output.length,
    elapsedMs,
  };
}

// ============================================================================
// Box modification functions
// ============================================================================

/**
 * Inflate mdhd (Media Header Box) timescale and duration by mult.
 * mdhd v0: 1 byte version, 3 bytes flags, 4 bytes creation, 4 bytes modification,
 *          4 bytes timescale, 4 bytes duration, 2 bytes language, 2 bytes quality
 * mdhd v1: same but creation/modification/duration are 8 bytes each.
 */
function inflateMdhd(mdia: Box, mult: number): void {
  const mdhd = findChild(mdia, "mdhd");
  if (!mdhd) return;
  const p = mdhd.payload;
  if (p.length < 4) return;
  const version = p[0];

  const newPayload = new Uint8Array(p.length);
  newPayload.set(p);

  if (version === 1) {
    // timescale at offset 20, duration at offset 24 (8 bytes)
    const oldTimescale = readU32(p, 20);
    writeU32(newPayload, 20, oldTimescale * mult);
    // 64-bit duration
    const oldDurationLo = readU32(p, 28);
    const oldDurationHi = readU32(p, 24);
    // Treat as 32-bit for simplicity (most files fit)
    if (oldDurationHi === 0) {
      const newDuration = oldDurationLo * mult;
      // Check for overflow
      if (newDuration > 0xffffffff) {
        // Use BigInt
        const big = BigInt(oldDurationLo) * BigInt(mult);
        writeU32(newPayload, 24, Number((big >> 32n) & 0xffffffffn));
        writeU32(newPayload, 28, Number(big & 0xffffffffn));
      } else {
        writeU32(newPayload, 24, 0);
        writeU32(newPayload, 28, newDuration);
      }
    } else {
      const big =
        (BigInt(readU32(p, 24)) << 32n) | BigInt(readU32(p, 28));
      const newBig = big * BigInt(mult);
      writeU32(newPayload, 24, Number((newBig >> 32n) & 0xffffffffn));
      writeU32(newPayload, 28, Number(newBig & 0xffffffffn));
    }
  } else {
    // version 0: timescale at 12, duration at 16 (4 bytes each)
    const oldTimescale = readU32(p, 12);
    const oldDuration = readU32(p, 16);
    writeU32(newPayload, 12, oldTimescale * mult);
    const newDuration = oldDuration * mult;
    if (newDuration <= 0xffffffff) {
      writeU32(newPayload, 16, newDuration);
    } else {
      // Need to upgrade to v1 - too complex for now, just truncate
      writeU32(newPayload, 16, newDuration >>> 0);
    }
  }
  mdhd.payload = newPayload;
}

/**
 * Inflate stts (Decoding Time to Sample Box).
 * Each entry is (sample_count, sample_delta). We multiply sample_count by mult.
 */
function inflateStts(stts: Box, mult: number): void {
  const p = stts.payload;
  if (p.length < 8) return;
  const entryCount = readU32(p, 4);
  const newPayload = new Uint8Array(p.length);
  newPayload.set(p);
  for (let i = 0; i < entryCount; i++) {
    const off = 8 + i * 8;
    if (off + 8 > p.length) break;
    const count = readU32(p, off);
    // 64-bit safe multiply (most files fit in 32 bits)
    const newCount = count * mult;
    if (newCount <= 0xffffffff) {
      writeU32(newPayload, off, newCount);
    } else {
      // Truncation - shouldn't happen for normal videos
      writeU32(newPayload, off, newCount >>> 0);
    }
  }
  stts.payload = newPayload;
}

/**
 * Inflate ctts (Composition Time to Sample Box).
 * Each entry is (sample_count, sample_offset). Multiply sample_count by mult.
 * Note: v1 ctts has signed offsets, but multiplication logic is the same.
 */
function inflateCtts(ctts: Box, mult: number): void {
  const p = ctts.payload;
  if (p.length < 8) return;
  const entryCount = readU32(p, 4);
  const newPayload = new Uint8Array(p.length);
  newPayload.set(p);
  for (let i = 0; i < entryCount; i++) {
    const off = 8 + i * 8;
    if (off + 8 > p.length) break;
    const count = readU32(p, off);
    const newCount = count * mult;
    writeU32(newPayload, off, newCount <= 0xffffffff ? newCount : newCount >>> 0);
  }
  ctts.payload = newPayload;
}

/**
 * Inflate stsz (Sample Size Box).
 * Format: 4 bytes version/flags, 4 bytes sample_size (uniform), 4 bytes sample_count,
 * then either nothing (if uniform) or sample_count * 4 bytes of sizes.
 *
 * If sample_size is non-zero (uniform), we just multiply sample_count by mult.
 * Otherwise, we repeat each size entry mult times.
 *
 * NOTE: This is the simple "per-sample" repetition that assumes 1 sample per chunk.
 * For multi-chunk files, use inflateStszByChunk() instead.
 */
function inflateStsz(stsz: Box, mult: number): void {
  const p = stsz.payload;
  if (p.length < 12) return;
  const uniformSize = readU32(p, 4);
  const sampleCount = readU32(p, 8);

  const newSampleCount = sampleCount * mult;

  if (uniformSize !== 0) {
    // Uniform sizes - just multiply count
    const newPayload = new Uint8Array(12);
    newPayload.set(p.subarray(0, 12));
    writeU32(newPayload, 8, newSampleCount <= 0xffffffff ? newSampleCount : newSampleCount >>> 0);
    stsz.payload = newPayload;
    return;
  }

  // Variable sizes - repeat each entry mult times
  const sizes = p.subarray(12, 12 + sampleCount * 4);
  const newPayload = new Uint8Array(12 + newSampleCount * 4);
  // Copy header
  newPayload.set(p.subarray(0, 12));
  writeU32(newPayload, 8, newSampleCount <= 0xffffffff ? newSampleCount : newSampleCount >>> 0);
  // Repeat each size mult times
  let writeOff = 12;
  for (let i = 0; i < sampleCount; i++) {
    const size = readU32(sizes, i * 4);
    for (let j = 0; j < mult; j++) {
      writeU32(newPayload, writeOff, size);
      writeOff += 4;
    }
  }
  stsz.payload = newPayload;
}

/**
 * Inflate stsz preserving the chunk structure.
 *
 * For each original chunk, we duplicate that chunk mult times in stco (each at
 * the same offset). For the decoder to read the same byte range from each
 * duplicate chunk, the sample sizes for each duplicate must match the original
 * chunk's sample sizes.
 *
 * This function reads stsc to determine samples_per_chunk for each chunk, then
 * for each chunk, repeats its sample sizes mult times in the new stsz.
 *
 * stsz format: 4 bytes version/flags, 4 bytes uniform_size, 4 bytes sample_count,
 *              then sample_count * 4 bytes of sizes (if uniform_size == 0).
 * stsc format: 4 bytes version/flags, 4 bytes entry_count,
 *              then entry_count * 12 bytes of (first_chunk, samples_per_chunk, desc_idx).
 */
function inflateStszByChunk(
  stsz: Box,
  stsc: Box,
  chunkCount: number,
  mult: number,
): void {
  const p = stsz.payload;
  if (p.length < 12) return;
  const uniformSize = readU32(p, 4);
  const sampleCount = readU32(p, 8);

  // For uniform sizes, every sample is the same size — order doesn't matter,
  // just multiply the count.
  if (uniformSize !== 0) {
    const newSampleCount = sampleCount * mult;
    const newPayload = new Uint8Array(12);
    newPayload.set(p.subarray(0, 12));
    writeU32(newPayload, 8, newSampleCount <= 0xffffffff ? newSampleCount : newSampleCount >>> 0);
    stsz.payload = newPayload;
    return;
  }

  // Parse stsc to get samples_per_chunk for each chunk
  const sp = stsc.payload;
  if (sp.length < 8) {
    inflateStsz(stsz, mult);
    return;
  }
  const stscEntryCount = readU32(sp, 4);
  const stscEntries: { firstChunk: number; samplesPerChunk: number }[] = [];
  for (let i = 0; i < stscEntryCount; i++) {
    const off = 8 + i * 12;
    if (off + 12 > sp.length) break;
    stscEntries.push({
      firstChunk: readU32(sp, off),
      samplesPerChunk: readU32(sp, off + 4),
    });
  }
  stscEntries.sort((a, b) => a.firstChunk - b.firstChunk);

  // Build samples_per_chunk array for each chunk
  const samplesPerChunkArr = new Array<number>(chunkCount).fill(0);
  for (let i = 0; i < stscEntries.length; i++) {
    const { firstChunk, samplesPerChunk } = stscEntries[i];
    const nextFirstChunk =
      i + 1 < stscEntries.length ? stscEntries[i + 1].firstChunk : chunkCount + 1;
    for (let c = firstChunk; c < nextFirstChunk && c <= chunkCount; c++) {
      samplesPerChunkArr[c - 1] = samplesPerChunk;
    }
  }
  // Fill any zero entries with the first entry's value
  if (stscEntries.length > 0) {
    const fallback = stscEntries[0].samplesPerChunk;
    for (let c = 0; c < chunkCount; c++) {
      if (samplesPerChunkArr[c] === 0) samplesPerChunkArr[c] = fallback;
    }
  }

  // For each chunk, repeat its sample sizes mult times in the new stsz
  const newSizes: number[] = [];
  let sampleIdx = 0;
  for (let c = 0; c < chunkCount; c++) {
    const count = samplesPerChunkArr[c];
    const chunkSizes: number[] = [];
    for (let i = 0; i < count; i++) {
      if (sampleIdx < sampleCount) {
        chunkSizes.push(readU32(p, 12 + sampleIdx * 4));
        sampleIdx++;
      }
    }
    for (let j = 0; j < mult; j++) {
      for (const s of chunkSizes) newSizes.push(s);
    }
  }

  const newSampleCount = newSizes.length;
  const newPayload = new Uint8Array(12 + newSampleCount * 4);
  newPayload.set(p.subarray(0, 12));
  writeU32(newPayload, 8, newSampleCount <= 0xffffffff ? newSampleCount : newSampleCount >>> 0);
  for (let i = 0; i < newSampleCount; i++) {
    writeU32(newPayload, 12 + i * 4, newSizes[i]);
  }
  stsz.payload = newPayload;
}

/**
 * Shift all chunk offsets in stco by offsetDelta, then inflate by repeating
 * each entry mult times.
 *
 * stco format: 4 bytes version/flags, 4 bytes entry_count, then entry_count * 4 bytes of offsets.
 */
function shiftAndInflateStco(stco: Box, offsetDelta: number, mult: number): void {
  const p = stco.payload;
  if (p.length < 8) return;
  const entryCount = readU32(p, 4);
  const newEntryCount = entryCount * mult;
  const newPayload = new Uint8Array(8 + newEntryCount * 4);
  // Copy version/flags
  newPayload.set(p.subarray(0, 4));
  writeU32(newPayload, 4, newEntryCount <= 0xffffffff ? newEntryCount : newEntryCount >>> 0);
  // Read original offsets, shift, and repeat mult times
  let writeOff = 8;
  for (let i = 0; i < entryCount; i++) {
    const off = 8 + i * 4;
    if (off + 4 > p.length) break;
    let offset = readU32(p, off);
    offset = (offset + offsetDelta) >>> 0;
    for (let j = 0; j < mult; j++) {
      writeU32(newPayload, writeOff, offset);
      writeOff += 4;
    }
  }
  stco.payload = newPayload;
}

/**
 * Shift all chunk offsets in co64 by offsetDelta, then inflate.
 * co64 uses 8-byte offsets.
 */
function shiftAndInflateCo64(co64: Box, offsetDelta: number, mult: number): void {
  const p = co64.payload;
  if (p.length < 8) return;
  const entryCount = readU32(p, 4);
  const newEntryCount = entryCount * mult;
  const newPayload = new Uint8Array(8 + newEntryCount * 8);
  newPayload.set(p.subarray(0, 4));
  writeU32(newPayload, 4, newEntryCount <= 0xffffffff ? newEntryCount : newEntryCount >>> 0);
  let writeOff = 8;
  const bigDelta = BigInt(offsetDelta);
  for (let i = 0; i < entryCount; i++) {
    const off = 8 + i * 8;
    if (off + 8 > p.length) break;
    let offset = readU64(p, off);
    offset = offset + bigDelta;
    if (offset < 0n) offset = 0n;
    for (let j = 0; j < mult; j++) {
      writeU64(newPayload, writeOff, offset);
      writeOff += 8;
    }
  }
  co64.payload = newPayload;
}

/**
 * Inflate stss (Sync Sample Box) keyframe indices.
 * Each original keyframe K expands to mult entries: (K-1)*mult + 1, (K-1)*mult + 2, ..., K*mult.
 * All mult duplicates reference the same data, so they're all keyframes if the original was.
 */
function inflateStss(stss: Box, mult: number): void {
  const p = stss.payload;
  if (p.length < 8) return;
  const entryCount = readU32(p, 4);
  const newEntryCount = entryCount * mult;
  const newPayload = new Uint8Array(8 + newEntryCount * 4);
  newPayload.set(p.subarray(0, 4));
  writeU32(newPayload, 4, newEntryCount <= 0xffffffff ? newEntryCount : newEntryCount >>> 0);
  let writeOff = 8;
  for (let i = 0; i < entryCount; i++) {
    const off = 8 + i * 4;
    if (off + 4 > p.length) break;
    const k = readU32(p, off);
    // Original keyframe K corresponds to new samples (K-1)*mult + 1 .. K*mult
    const baseK = (k - 1) * mult + 1;
    for (let j = 0; j < mult; j++) {
      const newK = baseK + j;
      writeU32(newPayload, writeOff, newK <= 0xffffffff ? newK : newK >>> 0);
      writeOff += 4;
    }
  }
  stss.payload = newPayload;
}

/**
 * Inflate sdtp (Sample Dependency Type Box).
 * Each byte describes one sample. Repeat each byte mult times.
 */
function inflateSdtp(sdtp: Box, mult: number): void {
  const p = sdtp.payload;
  if (p.length < 4) return;
  // 4 bytes version/flags, then 1 byte per sample
  const sampleCount = p.length - 4;
  const newPayload = new Uint8Array(4 + sampleCount * mult);
  newPayload.set(p.subarray(0, 4));
  let writeOff = 4;
  for (let i = 0; i < sampleCount; i++) {
    const b = p[4 + i];
    for (let j = 0; j < mult; j++) {
      newPayload[writeOff++] = b;
    }
  }
  sdtp.payload = newPayload;
}

/**
 * Set the encoder tag in udta/ilst.
 * Creates an ilst box with a ©too (encoding tool) atom if not present.
 */
function setEncoderTag(udta: Box, tag: string): void {
  let ilst = findChild(udta, "ilst");
  if (!ilst) {
    ilst = makeContainerBox("ilst", []);
    udta.children.push(ilst);
  }
  // Remove existing ©too
  ilst.children = ilst.children.filter((c) => c.type !== "\u00A9too");

  // Build data box payload: 4 bytes flags, 4 bytes type (1 = UTF-8), 4 bytes locale, then string
  const tagBytes = new TextEncoder().encode(tag);
  const dataPayload = new Uint8Array(16 + tagBytes.length);
  writeU32(dataPayload, 0, 1); // type indicator: 1 = UTF-8
  writeU32(dataPayload, 8, 0); // locale
  dataPayload.set(tagBytes, 16);

  const dataBox = makeLeafBox("data", dataPayload);
  // ©too is a container holding a data box
  const tooBox = makeContainerBox("\u00A9too", [dataBox]);
  ilst.children.unshift(tooBox);
}

/**
 * Set the handler_name in an hdlr box.
 * hdlr format: 4 bytes version/flags, 4 bytes pre_defined, 4 bytes handler_type,
 *              12 bytes reserved, then UTF-8 name (null-terminated).
 */
function setHandlerName(hdlr: Box, name: string): void {
  const p = hdlr.payload;
  if (p.length < 24) return;
  const nameBytes = new TextEncoder().encode(name);
  // New payload: 24 bytes header + name + 1 null byte
  const newPayload = new Uint8Array(24 + nameBytes.length + 1);
  // Copy first 24 bytes (version/flags, pre_defined, handler_type, reserved)
  newPayload.set(p.subarray(0, 24));
  newPayload.set(nameBytes, 24);
  // Null terminator already 0
  hdlr.payload = newPayload;
}

/**
 * Set tkhd width and height (16.16 fixed-point).
 * Width and height are the last 8 bytes of the tkhd payload.
 */
function setTkhdDimensions(tkhd: Box, width: number, height: number): void {
  const p = tkhd.payload;
  if (p.length < 8) return;
  const newPayload = new Uint8Array(p.length);
  newPayload.set(p);
  const widthFixed = Math.round(width * 65536);
  const heightFixed = Math.round(height * 65536);
  writeU32(newPayload, p.length - 8, widthFixed);
  writeU32(newPayload, p.length - 4, heightFixed);
  tkhd.payload = newPayload;
}

/**
 * Flame Inflation mode (alternative method).
 *
 * Combines sample duplication (multiplying samples per chunk in stsc, duplicating
 * sample sizes in stsz, keeping stco/co64 offsets unique) with all metadata
 * patch operations.
 */
async function hazeFlameInflation(
  data: Uint8Array,
  options: HazeOptions,
  onProgress?: ProgressCallback,
): Promise<HazeResult> {
  const startTime = performance.now();
  const mult = options.multiplier;

  onProgress?.("Parsing MP4 structure", 5);

  const boxes = parseMP4(data);
  if (boxes.length === 0) {
    throw new Error("No MP4 boxes found. Is this a valid MP4 file?");
  }

  const ftyp = boxes.find((b) => b.type === "ftyp");
  if (!ftyp) throw new Error("ftyp box not found - not a valid MP4 file.");

  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) throw new Error("moov box not found - cannot process.");

  const mdat = boxes.find((b) => b.type === "mdat");
  if (!mdat) throw new Error("mdat box not found - no media data.");

  onProgress?.("Locating video track", 15);

  const videoTrak = findVideoTrack(moov);
  if (!videoTrak) throw new Error("No video track found in moov.");

  const mdia = findChild(videoTrak, "mdia");
  if (!mdia) throw new Error("mdia box not found in video track.");
  const minf = findChild(mdia, "minf");
  if (!minf) throw new Error("minf box not found in video track.");
  const stbl = findChild(minf, "stbl");
  if (!stbl) throw new Error("stbl box not found in video track.");

  // Keyframe guard — same check as frame_inflation
  if (!options.forceEncode) {
    const stts = findChild(stbl, "stts");
    const stss = findChild(stbl, "stss");
    if (stts) {
      const sttsPayload = stts.payload;
      if (sttsPayload.length >= 8) {
        const entryCount = readU32(sttsPayload, 4);
        let sampleCount = 0;
        for (let i = 0; i < entryCount; i++) {
          const off = 8 + i * 8;
          if (off + 8 > sttsPayload.length) break;
          sampleCount += readU32(sttsPayload, off);
        }
        const keyframeCount = stss ? readU32(stss.payload, 4) : sampleCount;
        if (keyframeCount < sampleCount) {
          throw new HazeKeyframeError(sampleCount, keyframeCount);
        }
      }
    }
  }

  // Compute mdat offset shift
  const oldMdatOffset = mdat.fileOffset;
  const newMdatOffset = ftyp.fileOffset + ftyp.size;
  const offsetDelta = newMdatOffset - oldMdatOffset;

  onProgress?.("Inflating timescale & sample tables (flame)", 30);

  // 1. Inflate mdhd timescale and duration (requested current modification)
  inflateMdhd(mdia, mult);

  // 2. Inflate stts sample count
  const stts = findChild(stbl, "stts");
  if (stts) {
    inflateStts(stts, mult);
  }

  // 3. Inflate ctts sample count if present
  const ctts = findChild(stbl, "ctts");
  if (ctts) {
    inflateCtts(ctts, mult);
  }

  // 4. Inflate stsc (Sample-to-Chunk): multiply samples_per_chunk
  const stsc = findChild(stbl, "stsc");
  if (stsc) {
    inflateStscFlame(stsc, mult);
  }

  onProgress?.("Inflating sample sizes (flame)", 45);

  // 5. Inflate stsz (Sample Sizes): repeat each size mult times
  const stsz = findChild(stbl, "stsz");
  if (stsz) {
    inflateStsz(stsz, mult);
  }

  onProgress?.("Shifting chunk offsets (flame)", 60);

  // 6. Shift stco/co64 chunk offsets by offsetDelta (do NOT duplicate offsets)
  const stco = findChild(stbl, "stco");
  if (stco) {
    shiftStco(stco, offsetDelta);
  }
  const co64 = findChild(stbl, "co64");
  if (co64) {
    shiftCo64(co64, offsetDelta);
  }

  // 7. Handle stss/sync samples
  if (options.dropSyncSamples) {
    removeChildren(stbl, ["stss", "stps", "sdtp"]);
  } else {
    const stss = findChild(stbl, "stss");
    if (stss) {
      inflateStss(stss, mult);
    }
    removeChildren(stbl, ["sdtp"]);
  }

  onProgress?.("Writing encoder tag & handler name", 75);

  // 8. Add encoder tag to trak/udta/ilst
  let udta = findChild(videoTrak, "udta");
  if (!udta) {
    udta = makeContainerBox("udta", []);
    videoTrak.children.push(udta);
  }
  setEncoderTag(udta, options.encoderTag);

  // 9. Update handler_name in hdlr
  const hdlr = findChild(mdia, "hdlr");
  if (hdlr) {
    setHandlerName(hdlr, options.handlerName);
  }

  // 10. Force TikTok 9:16 matrix if enabled
  if (options.forceTikTok9x16) {
    const tkhd = findChild(videoTrak, "tkhd");
    if (tkhd) {
      setTkhdDimensions(tkhd, options.tikTokWidth, options.tikTokHeight);
    }
  }

  onProgress?.("Reordering boxes (moov after mdat)", 85);

  // 11. Reorder top-level boxes: [ftyp] [mdat] [moov]
  const reordered: Box[] = [];
  reordered.push(ftyp);
  reordered.push(mdat);
  for (const b of boxes) {
    if (b.type !== "ftyp" && b.type !== "mdat") {
      reordered.push(b);
    }
  }

  onProgress?.("Serializing output", 95);

  const output = writeMP4(reordered);
  const elapsedMs = performance.now() - startTime;
  onProgress?.("Done", 100);

  return {
    output,
    inputSize: data.length,
    outputSize: output.length,
    elapsedMs,
  };
}

/**
 * Inflate stsc by multiplying samples_per_chunk by mult.
 */
function inflateStscFlame(stsc: Box, mult: number): void {
  const p = stsc.payload;
  if (p.length < 8) return;
  const entryCount = readU32(p, 4);
  const newPayload = new Uint8Array(p.length);
  newPayload.set(p);
  for (let i = 0; i < entryCount; i++) {
    const off = 8 + i * 12;
    if (off + 12 > p.length) break;
    const samplesPer = readU32(p, off + 4);
    const newSamplesPer = samplesPer * mult;
    writeU32(
      newPayload,
      off + 4,
      newSamplesPer <= 0xffffffff ? newSamplesPer : newSamplesPer >>> 0,
    );
  }
  stsc.payload = newPayload;
}

/**
 * Inflate sample tables inside stbl to declare mult× more frames.
 *
 * Each original chunk is duplicated into mult "virtual chunks" that all point
 * to the same byte range in mdat. The decoder reads the same data mult times
 * per original chunk, producing clean duplicate frames (not garbage).
 *
 * CRITICAL: We do NOT inflate stsc.samples_per_chunk. That approach (from the
 * original Python inflate_frames_mp4.py) makes the decoder read past each
 * chunk's actual byte range, producing fake/garbage frames at the end. Instead,
 * we duplicate stco entries so each virtual chunk has a valid offset, and
 * inflate stsz per-chunk to match the new chunk structure.
 *
 * Operations:
 *   - stts: multiply each entry's sample_count by mult (sample_delta unchanged)
 *   - stsc: left unchanged (virtual chunks inherit the same samples_per_chunk)
 *   - stsz: for each original chunk, repeat its sample sizes mult times
 *   - stco/co64: caller duplicates entries via shiftAndInflateStco/Co64
 *   - stss: remap keyframe indices or drop entirely
 *
 * @param stbl - The Sample Table Box to inflate.
 * @param mult - The frame multiplier (e.g. 19).
 * @param dropSync - When true, drop stss/stps/sdtp instead of inflating stss.
 */
function inflateStblPythonStyle(
  stbl: Box,
  mult: number,
  dropSync: boolean,
): void {
  // stts (Time-to-Sample Box): multiply sample_count by mult
  const stts = findChild(stbl, "stts");
  if (stts) inflateStts(stts, mult);

  // stsc: left UNCHANGED — virtual chunks inherit the same samples_per_chunk.
  // Do NOT call inflateStscFlame() here — that would make the decoder read
  // past each chunk's byte range, producing garbage frames.

  // stsz (Sample Size Box): inflate per-chunk so each virtual chunk's sample
  // sizes match the original chunk's sizes.
  const stsz = findChild(stbl, "stsz");
  const stsc = findChild(stbl, "stsc");
  const stco = findChild(stbl, "stco");
  const co64 = findChild(stbl, "co64");
  const chunkCount = stco
    ? readU32(stco.payload, 4)
    : co64
      ? Number(readU64(co64.payload, 4))
      : 0;
  if (stsz && stsc && chunkCount > 0) {
    inflateStszByChunk(stsz, stsc, chunkCount, mult);
  } else if (stsz) {
    inflateStsz(stsz, mult);
  }

  // stss (Sync Sample Box) / stps / sdtp handling
  if (dropSync) {
    removeChildren(stbl, ["stss", "stps", "sdtp"]);
  } else {
    const stss = findChild(stbl, "stss");
    if (stss) inflateStss(stss, mult);
    removeChildren(stbl, ["sdtp"]);
  }
}
