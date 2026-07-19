/**
 * MP4 Box types for the haze encoder.
 *
 * MP4 (ISO Base Media File Format) is structured as a sequence of "boxes" (also
 * called "atoms"). Each box has:
 *   - 4 bytes: size (big-endian uint32, includes the size+type fields)
 *   - 4 bytes: type (ASCII, 4 chars)
 *   - If size === 1: 8 more bytes for 64-bit largeSize
 *   - If size === 0: box extends to end of file
 *   - Payload bytes: (size - headerSize)
 *
 * Container boxes have other boxes as children. Leaf boxes have raw payload.
 */

/** A single MP4 box parsed into memory. */
export interface Box {
  /** 4-character ASCII type, e.g. "moov", "trak", "stts". */
  type: string;
  /** Total size in bytes including header. */
  size: number;
  /** Header size: 8 (normal) or 16 (when largeSize is used). */
  headerSize: number;
  /** Offset of this box's first byte within the original file. */
  fileOffset: number;
  /** Raw payload bytes (after header). For container boxes this is the concatenation of children. */
  payload: Uint8Array;
  /** Children boxes (only for container boxes). */
  children: Box[];
  /** Whether this box is a container. */
  isContainer: boolean;
}

/** Options that control haze encoding behaviour. */
export interface HazeOptions {
  /** Internal frame multiplier. Default 19 (matches haze_encode.sh). */
  multiplier: number;
  /** Encoder tag string written into track + movie metadata. */
  encoderTag: string;
  /** handler_name written into the video hdlr box. */
  handlerName: string;
  /** When true, overwrite tkhd display matrix to force TikTok 9:16 (1080x1920). */
  forceTikTok9x16: boolean;
  /** Width to declare in tkhd when forceTikTok9x16 is true. */
  tikTokWidth: number;
  /** Height to declare in tkhd when forceTikTok9x16 is true. */
  tikTokHeight: number;
  /** When true, drop the stss (sync sample) box so every sample is treated as a keyframe. */
  dropSyncSamples: boolean;
  /**
   * When true, encode even if the input video has P/B-frames. The output's
   * metadata will report the inflated FPS, but the video will have visible
   * artifacts (P-frame deltas compound when decoded 19×). Defaults to false —
   * the encoder throws when the input is not all-I-frame.
   */
  forceEncode: boolean;
  /**
   * When true, automatically pre-process the input with ffmpeg.wasm to
   * all-I-frame before haze encoding. This produces an artifact-free output
   * for any input. Takes precedence over forceEncode (if both are true,
   * autoPreprocess wins and no error is thrown). Defaults to true.
   */
  autoPreprocess: boolean;
}

export const DEFAULT_OPTIONS: HazeOptions = {
  multiplier: 19,
  encoderTag: "Haze Encoder - haze.vercel.app",
  handlerName: "VideoHandler",
  forceTikTok9x16: true,
  tikTokWidth: 1080,
  tikTokHeight: 1920,
  dropSyncSamples: true,
  forceEncode: false,
  autoPreprocess: true,
};

/** Snapshot of the metadata we report to the UI before/after encoding. */
export interface VideoMetadata {
  width: number;
  height: number;
  /** r_frame_rate = timescale / gcd(stts deltas). */
  fps: number;
  /** avg_frame_rate = sampleCount / duration_seconds. */
  avgFps: number;
  /** Duration in seconds. */
  duration: number;
  /** Media header timescale. */
  timescale: number;
  /** Total declared samples in stts. */
  sampleCount: number;
  /** Number of keyframes (sync samples) declared in stss. If stss is absent, every sample is a keyframe (per ISO/IEC 14496-12). */
  keyframeCount: number;
  /** True when every sample is a keyframe (stss absent, or stss entry count == sample count). */
  allKeyframes: boolean;
  /** True when the codec is HEVC (hvc1/hev1) — affects NAL unit framing. */
  isHevc: boolean;
  /** Codec fourcc from stsd (e.g. "avc1", "hvc1", "hev1", "mp4v"). */
  codec: string;
  /** Encoder tag from udta/ilst (©too or encoder field). */
  encoderTag: string | null;
  /** handler_name from hdlr. */
  handlerName: string | null;
  /** True when moov is AFTER mdat (i.e. faststart is OFF). */
  moovAtEnd: boolean;
  mdatOffset: number;
  moovOffset: number;
  /** File size in bytes. */
  fileSize: number;
}

/** Container box types we recurse into during parsing. */
export const CONTAINER_TYPES = new Set([
  "moov",
  "trak",
  "mdia",
  "minf",
  "stbl",
  "dinf",
  "udta",
  "edts",
  "mvex",
  "moof",
  "traf",
  "mfra",
  "skip",
  "strk",
  "tref",
  "ipmc",
  "sinf",
  "schi",
  "ilst",
]);

/**
 * The "meta" box is special: in QuickTime/MP4 it has a 4-byte version/flags
 * field before its children. We treat it as a container but skip those 4 bytes
 * when parsing children.
 */
export const META_TYPE = "meta";
