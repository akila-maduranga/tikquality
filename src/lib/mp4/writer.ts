/**
 * MP4 box writer / serializer.
 *
 * After we modify a box's payload (or its children), we need to recompute the
 * size and write it back out as bytes. The writer walks the tree and produces a
 * single Uint8Array for the whole file.
 */

import { Box } from "./types";
import { writeU32, writeU64 } from "./parser";

/**
 * Compute the total byte size of a box (including header) after serialization.
 * Recursively sums children for container boxes.
 */
export function computeBoxSize(box: Box): number {
  if (box.isContainer) {
    let payloadSize = 0;
    for (const child of box.children) {
      payloadSize += computeBoxSize(child);
    }
    // Special case: meta box has 4-byte version/flags prefix
    if (box.type === "meta") payloadSize += 4;
    // Use 16-byte header if payload > 2^32 - 8
    if (payloadSize + 8 > 0xffffffff) {
      return payloadSize + 16;
    }
    return payloadSize + 8;
  }
  // Leaf box: header + payload.length
  if (box.payload.length + 8 > 0xffffffff) {
    return box.payload.length + 16;
  }
  return box.payload.length + 8;
}

/**
 * Serialize a box (and its children) into a Uint8Array.
 */
export function writeBox(box: Box): Uint8Array {
  const totalSize = computeBoxSize(box);
  const buf = new Uint8Array(totalSize);
  writeBoxInto(box, buf, 0);
  return buf;
}

/**
 * Serialize a box into an existing buffer at the given offset.
 * Returns the new offset (after the written box).
 */
export function writeBoxInto(box: Box, buf: Uint8Array, offset: number): number {
  const totalSize = computeBoxSize(box);
  const useLargeSize = totalSize > 0xffffffff;

  // Header
  if (useLargeSize) {
    writeU32(buf, offset, 1);
    writeAscii(buf, offset + 4, box.type);
    writeU64(buf, offset + 8, BigInt(totalSize));
    offset += 16;
  } else {
    writeU32(buf, offset, totalSize);
    writeAscii(buf, offset + 4, box.type);
    offset += 8;
  }

  if (box.isContainer) {
    if (box.type === "meta") {
      // 4 bytes version/flags (kept zero)
      writeU32(buf, offset, 0);
      offset += 4;
    }
    for (const child of box.children) {
      offset = writeBoxInto(child, buf, offset);
    }
  } else {
    buf.set(box.payload, offset);
    offset += box.payload.length;
  }

  return offset;
}

/** Write 4 ASCII characters into a buffer. */
function writeAscii(buf: Uint8Array, offset: number, type: string): void {
  for (let i = 0; i < 4; i++) {
    buf[offset + i] = type.charCodeAt(i) ?? 0;
  }
}

/**
 * Serialize an array of top-level boxes into a Uint8Array.
 */
export function writeMP4(boxes: Box[]): Uint8Array {
  let totalSize = 0;
  for (const box of boxes) {
    totalSize += computeBoxSize(box);
  }
  const buf = new Uint8Array(totalSize);
  let offset = 0;
  for (const box of boxes) {
    offset = writeBoxInto(box, buf, offset);
  }
  return buf;
}

/**
 * Allocate a fresh payload Uint8Array of the given size for a leaf box.
 * Returns the new payload buffer (caller must fill it in, then assign to box.payload).
 */
export function allocPayload(size: number): Uint8Array {
  return new Uint8Array(size);
}

/**
 * Replace a child box within a parent's children array.
 */
export function replaceChild(parent: Box, newChild: Box): void {
  const idx = parent.children.findIndex((c) => c.type === newChild.type);
  if (idx >= 0) {
    parent.children[idx] = newChild;
  } else {
    parent.children.push(newChild);
  }
}

/**
 * Remove all children of the given types from a parent.
 */
export function removeChildren(parent: Box, types: string[]): void {
  parent.children = parent.children.filter((c) => !types.includes(c.type));
}

/**
 * Create a new leaf box with the given type and payload.
 */
export function makeLeafBox(type: string, payload: Uint8Array): Box {
  return {
    type,
    size: 0, // recomputed on write
    headerSize: 8,
    fileOffset: 0,
    payload,
    children: [],
    isContainer: false,
  };
}

/**
 * Create a new container box with the given type and children.
 */
export function makeContainerBox(type: string, children: Box[] = []): Box {
  return {
    type,
    size: 0,
    headerSize: 8,
    fileOffset: 0,
    payload: new Uint8Array(0),
    children,
    isContainer: true,
  };
}
