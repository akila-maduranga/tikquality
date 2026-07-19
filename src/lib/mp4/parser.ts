/**
 * MP4 box parser.
 *
 * Reads an MP4 file into a tree of Box objects. Each Box keeps a reference to
 * its payload bytes (Uint8Array view into the source buffer) so we can modify
 * specific child boxes without re-serialising everything.
 */

import {
  Box,
  CONTAINER_TYPES,
  META_TYPE,
} from "./types";

/** Read a big-endian uint32 from a Uint8Array at the given offset. */
export function readU32(buf: Uint8Array, offset: number): number {
  return (
    (buf[offset] << 24) |
    (buf[offset + 1] << 16) |
    (buf[offset + 2] << 8) |
    buf[offset + 3]
  ) >>> 0;
}

/** Read a big-endian uint64 from a Uint8Array at the given offset (as BigInt). */
export function readU64(buf: Uint8Array, offset: number): bigint {
  return (
    (BigInt(buf[offset]) << 56n) |
    (BigInt(buf[offset + 1]) << 48n) |
    (BigInt(buf[offset + 2]) << 40n) |
    (BigInt(buf[offset + 3]) << 32n) |
    (BigInt(buf[offset + 4]) << 24n) |
    (BigInt(buf[offset + 5]) << 16n) |
    (BigInt(buf[offset + 6]) << 8n) |
    BigInt(buf[offset + 7])
  );
}

/** Write a big-endian uint32 into a Uint8Array at the given offset. */
export function writeU32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/** Write a big-endian uint64 into a Uint8Array at the given offset. */
export function writeU64(buf: Uint8Array, offset: number, value: bigint): void {
  buf[offset] = Number((value >> 56n) & 0xffn);
  buf[offset + 1] = Number((value >> 48n) & 0xffn);
  buf[offset + 2] = Number((value >> 40n) & 0xffn);
  buf[offset + 3] = Number((value >> 32n) & 0xffn);
  buf[offset + 4] = Number((value >> 24n) & 0xffn);
  buf[offset + 5] = Number((value >> 16n) & 0xffn);
  buf[offset + 6] = Number((value >> 8n) & 0xffn);
  buf[offset + 7] = Number(value & 0xffn);
}

/** Convert 4 ASCII bytes to a string. */
function fourcc(buf: Uint8Array, offset: number): string {
  return String.fromCharCode(
    buf[offset],
    buf[offset + 1],
    buf[offset + 2],
    buf[offset + 3],
  );
}

/**
 * Returns true if the type string looks like an iTunes metadata atom.
 * These atoms (©too, ©nam, ©ART, ©alb, ©day, ©gen, etc.) all start with
 * the © character (U+00A9) and contain a `data` child atom.
 */
function isItunesMetadataAtom(type: string): boolean {
  return type.length === 4 && type.charCodeAt(0) === 0xa9;
}

/**
 * Parse a single box starting at `offset` within `buf`.
 * Returns the Box and the offset of the next box.
 */
function parseBox(buf: Uint8Array, offset: number, end: number): Box | null {
  if (offset + 8 > end) return null;

  const size = readU32(buf, offset);
  const type = fourcc(buf, offset + 4);

  let headerSize = 8;
  let totalSize = size;

  if (size === 1) {
    // 64-bit largeSize
    if (offset + 16 > end) return null;
    headerSize = 16;
    totalSize = Number(readU64(buf, offset + 8));
  } else if (size === 0) {
    // Box extends to end of file
    totalSize = end - offset;
  }

  if (totalSize < headerSize) return null;
  if (offset + totalSize > end) {
    // Truncated box - clamp to end
    totalSize = end - offset;
  }

  const payloadStart = offset + headerSize;
  const payloadEnd = offset + totalSize;
  const payload = buf.subarray(payloadStart, payloadEnd);

  const isContainer =
    CONTAINER_TYPES.has(type) ||
    type === META_TYPE ||
    isItunesMetadataAtom(type);
  const children: Box[] = [];

  if (isContainer) {
    let childOffset = payloadStart;
    // meta box has a 4-byte version/flags before children
    if (type === META_TYPE) {
      childOffset += 4;
    }
    while (childOffset < payloadEnd) {
      const child = parseBox(buf, childOffset, payloadEnd);
      if (!child) break;
      children.push(child);
      childOffset += child.size;
    }
  }

  return {
    type,
    size: totalSize,
    headerSize,
    fileOffset: offset,
    payload,
    children,
    isContainer,
  };
}

/** Parse all top-level boxes in an MP4 file. */
export function parseMP4(buf: Uint8Array): Box[] {
  const boxes: Box[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const box = parseBox(buf, offset, buf.length);
    if (!box) break;
    boxes.push(box);
    offset += box.size;
  }
  return boxes;
}

/** Find the first child box of the given type. */
export function findChild(parent: Box, type: string): Box | null {
  for (const child of parent.children) {
    if (child.type === type) return child;
  }
  return null;
}

/** Find all child boxes of the given type. */
export function findChildren(parent: Box, type: string): Box[] {
  return parent.children.filter((c) => c.type === type);
}

/** Find the first video track (trak containing a video hdlr). */
export function findVideoTrack(moov: Box): Box | null {
  for (const trak of findChildren(moov, "trak")) {
    const mdia = findChild(trak, "mdia");
    if (!mdia) continue;
    const hdlr = findChild(mdia, "hdlr");
    if (!hdlr) continue;
    // hdlr payload: 4 bytes version/flags, 4 bytes pre_defined, 4 bytes handler_type
    if (hdlr.payload.length >= 12) {
      const handlerType = fourcc(hdlr.payload, 8);
      if (handlerType === "vide") return trak;
    }
  }
  // Fallback: first trak
  return findChild(moov, "trak");
}

/** Find the audio track (trak containing an audio hdlr). */
export function findAudioTrack(moov: Box): Box | null {
  for (const trak of findChildren(moov, "trak")) {
    const mdia = findChild(trak, "mdia");
    if (!mdia) continue;
    const hdlr = findChild(mdia, "hdlr");
    if (!hdlr) continue;
    if (hdlr.payload.length >= 12) {
      const handlerType = fourcc(hdlr.payload, 8);
      if (handlerType === "soun") return trak;
    }
  }
  return null;
}

/** Compute the greatest common divisor of an array of numbers. */
export function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

export function gcdArray(arr: number[]): number {
  if (arr.length === 0) return 0;
  let g = arr[0];
  for (let i = 1; i < arr.length; i++) {
    g = gcd(g, arr[i]);
    if (g === 1) break;
  }
  return g;
}
