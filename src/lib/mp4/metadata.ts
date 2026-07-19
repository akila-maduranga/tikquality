/**
 * MP4 metadata reader.
 *
 * Extracts video metadata (resolution, fps, duration, encoder tag, etc.) from
 * an MP4 file for display in the UI before/after haze encoding.
 */

import { Box, VideoMetadata } from "./types";
import { findAudioTrack, findChild, findVideoTrack, gcdArray, readU32 } from "./parser";

/** Find the moov box in top-level boxes. */
export function findMoov(boxes: Box[]): Box | null {
  for (const b of boxes) if (b.type === "moov") return b;
  return null;
}

/** Find the mdat box in top-level boxes. */
export function findMdat(boxes: Box[]): Box | null {
  for (const b of boxes) if (b.type === "mdat") return b;
  return null;
}

/** Find the ftyp box in top-level boxes. */
export function findFtyp(boxes: Box[]): Box | null {
  for (const b of boxes) if (b.type === "ftyp") return b;
  return null;
}

/** Parse mvhd (Movie Header Box) - returns timescale + duration. */
function parseMvhd(mvhd: Box): { timescale: number; duration: number } {
  const p = mvhd.payload;
  if (p.length < 4) return { timescale: 0, duration: 0 };
  const version = p[0];
  if (version === 1) {
    // 8 bytes creation, 8 bytes modification, 4 timescale, 8 duration
    if (p.length < 32) return { timescale: 0, duration: 0 };
    const timescale = readU32(p, 20);
    // 64-bit duration at offset 24
    const durationLo = readU32(p, 28);
    return { timescale, duration: durationLo };
  }
  // version 0: 4 bytes creation, 4 modification, 4 timescale, 4 duration
  if (p.length < 20) return { timescale: 0, duration: 0 };
  const timescale = readU32(p, 12);
  const duration = readU32(p, 16);
  return { timescale, duration };
}

/** Parse mdhd (Media Header Box) - returns timescale + duration. */
export function parseMdhd(mdhd: Box): { timescale: number; duration: number } {
  const p = mdhd.payload;
  if (p.length < 4) return { timescale: 0, duration: 0 };
  const version = p[0];
  if (version === 1) {
    if (p.length < 36) return { timescale: 0, duration: 0 };
    const timescale = readU32(p, 20);
    const durationLo = readU32(p, 28);
    return { timescale, duration: durationLo };
  }
  if (p.length < 24) return { timescale: 0, duration: 0 };
  const timescale = readU32(p, 12);
  const duration = readU32(p, 16);
  return { timescale, duration };
}

/** Parse tkhd (Track Header Box) - returns width, height (in 16.16 fixed-point). */
export function parseTkhd(tkhd: Box): { width: number; height: number } {
  const p = tkhd.payload;
  if (p.length < 4) return { width: 0, height: 0 };
  const version = p[0];
  // version 1: 4 flags + 8 creation + 8 mod + 4 trackID + 4 reserved + 8 duration + ...
  // version 0: 4 flags + 4 creation + 4 mod + 4 trackID + 4 reserved + 4 duration + ...
  // width/height are at the end (last 8 bytes), in 16.16 fixed-point
  const widthFixed = readU32(p, p.length - 8);
  const heightFixed = readU32(p, p.length - 4);
  return {
    width: widthFixed / 65536,
    height: heightFixed / 65536,
  };
}

/** Parse stts (Decoding Time to Sample Box) - returns sample count, total duration, deltas GCD. */
export function parseStts(stts: Box): {
  sampleCount: number;
  totalDuration: number;
  deltasGcd: number;
  uniqueDeltas: number[];
} {
  const p = stts.payload;
  if (p.length < 8) return { sampleCount: 0, totalDuration: 0, deltasGcd: 0, uniqueDeltas: [] };
  const entryCount = readU32(p, 4);
  let sampleCount = 0;
  let totalDuration = 0;
  const uniqueDeltas: number[] = [];
  for (let i = 0; i < entryCount; i++) {
    const off = 8 + i * 8;
    if (off + 8 > p.length) break;
    const count = readU32(p, off);
    const delta = readU32(p, off + 4);
    sampleCount += count;
    totalDuration += count * delta;
    if (!uniqueDeltas.includes(delta)) uniqueDeltas.push(delta);
  }
  const deltasGcd = uniqueDeltas.length > 0 ? gcdArray(uniqueDeltas) : 0;
  return { sampleCount, totalDuration, deltasGcd, uniqueDeltas };
}

/** Parse hdlr (Handler Box) - returns handler_type and handler_name. */
export function parseHdlr(hdlr: Box): { handlerType: string; handlerName: string } {
  const p = hdlr.payload;
  if (p.length < 24) return { handlerType: "", handlerName: "" };
  // 4 bytes version/flags, 4 bytes pre_defined, 4 bytes handler_type, 12 bytes reserved, then name (UTF-8 zero-terminated)
  const handlerType = String.fromCharCode(p[8], p[9], p[10], p[11]);
  // Name starts at offset 24 (or 32 if reserved is 12 bytes - but standard is 12)
  let nameEnd = 24;
  while (nameEnd < p.length && p[nameEnd] !== 0) nameEnd++;
  const handlerName = new TextDecoder("utf-8").decode(p.subarray(24, nameEnd));
  return { handlerType, handlerName };
}

/**
 * Find the encoder tag in udta/ilst metadata.
 * Looks for ©too (encoding tool), ©enc, or encoder atoms.
 */
function findEncoderTag(udta: Box | null): string | null {
  if (!udta) return null;
  const ilst = findChild(udta, "ilst");
  if (!ilst) {
    // Also check direct children for ©too etc.
    for (const child of udta.children) {
      if (child.type === "\u00A9too" || child.type === "\u00A9enc") {
        return extractIlstValue(child);
      }
    }
    return null;
  }
  for (const child of ilst.children) {
    if (child.type === "\u00A9too" || child.type === "\u00A9enc" || child.type === "\u00A9nam") {
      const v = extractIlstValue(child);
      if (v) return v;
    }
  }
  return null;
}

/** Extract the string value from an ilst metadata atom (data sub-box). */
function extractIlstValue(atom: Box): string | null {
  const data = findChild(atom, "data");
  if (!data) return null;
  // data box: 4 bytes version/flags, 4 bytes type indicator, 4 bytes locale, then value
  if (data.payload.length < 16) return null;
  const value = data.payload.subarray(16);
  return new TextDecoder("utf-8").decode(value).replace(/\0+$/, "");
}

/** Read complete video metadata from a parsed MP4 tree. */
export function readMetadata(boxes: Box[], fileSize: number): VideoMetadata | null {
  const moov = findMoov(boxes);
  if (!moov) return null;
  const mdat = findMdat(boxes);
  const ftyp = findFtyp(boxes);

  const trak = findVideoTrack(moov);
  if (!trak) return null;

  const mdia = findChild(trak, "mdia");
  if (!mdia) return null;
  const mdhd = findChild(mdia, "mdhd");
  const hdlr = findChild(mdia, "hdlr");
  const tkhd = findChild(trak, "tkhd");
  if (!mdhd || !tkhd) return null;

  const minf = findChild(mdia, "minf");
  const stbl = minf ? findChild(minf, "stbl") : null;
  const stts = stbl ? findChild(stbl, "stts") : null;
  const stss = stbl ? findChild(stbl, "stss") : null;
  const stsd = stbl ? findChild(stbl, "stsd") : null;

  const { timescale, duration: mdhdDuration } = parseMdhd(mdhd);
  const { width, height } = parseTkhd(tkhd);
  const sttsInfo = stts
    ? parseStts(stts)
    : { sampleCount: 0, totalDuration: 0, deltasGcd: 0, uniqueDeltas: [] };

  const handlerInfo = hdlr ? parseHdlr(hdlr) : { handlerType: "", handlerName: "" };

  const udta = findChild(trak, "udta");
  const encoderTag = findEncoderTag(udta);

  // Keyframe detection: if stss is absent, every sample is a keyframe (per ISO/IEC 14496-12).
  // If stss is present, only the listed samples are keyframes.
  let keyframeCount = sttsInfo.sampleCount;
  let allKeyframes = true;
  if (stss) {
    keyframeCount = readU32(stss.payload, 4);
    allKeyframes = keyframeCount >= sttsInfo.sampleCount;
  }

  // Codec detection from stsd
  const codec = stsd ? parseStsdCodec(stsd) : "";
  const isHevc = codec === "hvc1" || codec === "hev1" || codec === "hvc2" || codec === "hev2";

  // r_frame_rate = timescale / deltasGcd
  const fps = sttsInfo.deltasGcd > 0 ? timescale / sttsInfo.deltasGcd : 0;
  // avg_frame_rate = sampleCount / duration_seconds
  const durationSeconds = timescale > 0 ? mdhdDuration / timescale : 0;
  const avgFps = durationSeconds > 0 ? sttsInfo.sampleCount / durationSeconds : 0;

  // Determine moov position vs mdat position
  const moovOffset = moov.fileOffset;
  const mdatOffset = mdat ? mdat.fileOffset : -1;
  const moovAtEnd = mdatOffset >= 0 && moovOffset > mdatOffset;

  return {
    width,
    height,
    fps,
    avgFps,
    duration: durationSeconds,
    timescale,
    sampleCount: sttsInfo.sampleCount,
    keyframeCount,
    allKeyframes,
    isHevc,
    codec,
    encoderTag,
    handlerName: handlerInfo.handlerName,
    moovAtEnd,
    mdatOffset,
    moovOffset,
    fileSize,
  };
}

/** Parse stsd (Sample Description Box) to extract the codec fourcc. */
function parseStsdCodec(stsd: Box): string {
  const p = stsd.payload;
  if (p.length < 16) return "";
  // stsd: 4 bytes version/flags, 4 bytes entry_count, then sample entries
  // Each video sample entry: 4 bytes size, 4 bytes type (fourcc), ...
  // The first entry starts at offset 8.
  const entryOffset = 8;
  if (entryOffset + 8 > p.length) return "";
  return String.fromCharCode(
    p[entryOffset + 4],
    p[entryOffset + 5],
    p[entryOffset + 6],
    p[entryOffset + 7],
  );
}

/** Format a file size in bytes as a human-readable string. */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/** Format a duration in seconds as HH:MM:SS.mmm. */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${h.toString().padStart(2, "0")}:${m
    .toString()
    .padStart(2, "0")}:${s.toString().padStart(2, "0")}.${ms
    .toString()
    .padStart(3, "0")}`;
}
