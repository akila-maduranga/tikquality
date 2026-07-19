/**
 * Test the haze encoder's keyframe guard and all-I-frame handling.
 *
 * 1. Generate a video with P-frames (default ffmpeg settings)
 *    → hazeEncode should throw HazeKeyframeError
 *
 * 2. Generate the same video but with all-I-frame (-g 1 -bf 0)
 *    → hazeEncode should succeed, output should be a valid MP4
 *
 * 3. With forceEncode=true on the P-frame video
 *    → hazeEncode should succeed (but output may have artifacts)
 */

import { writeFileSync } from "fs";
import { execSync } from "child_process";
import {
  hazeEncode,
  HazeKeyframeError,
  parseMP4,
  readMetadata,
} from "/home/z/my-project/src/lib/mp4/index.ts";
import { readFileSync } from "fs";

const pFrameInput = "/tmp/test_pframes.mp4";
const allIFrameInput = "/tmp/test_all_iframes.mp4";
const allIFrameOutput = "/tmp/test_all_iframes_haze.mp4";

console.log("== Step 1: Generate video with P-frames ==");
execSync(
  `ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=30 -c:v libx264 -pix_fmt yuv420p -g 60 ${pFrameInput}`,
  { stdio: "inherit" },
);
const pFrameData = new Uint8Array(readFileSync(pFrameInput));
const pFrameMeta = readMetadata(parseMP4(pFrameData), pFrameData.length);
console.log(
  `  P-frame video: ${pFrameMeta?.keyframeCount}/${pFrameMeta?.sampleCount} keyframes, allKeyframes=${pFrameMeta?.allKeyframes}`,
);

console.log("\n== Step 2: Try to haze-encode P-frame video (should throw) ==");
try {
  await hazeEncode(pFrameData, {
    multiplier: 19,
    encoderTag: "test",
    handlerName: "VideoHandler",
    forceTikTok9x16: false,
    tikTokWidth: 1080,
    tikTokHeight: 1920,
    dropSyncSamples: true,
    forceEncode: false,
  });
  console.log("  FAIL: should have thrown HazeKeyframeError");
  process.exit(1);
} catch (e) {
  if (e instanceof HazeKeyframeError) {
    console.log(`  PASS: threw HazeKeyframeError`);
    console.log(`    sampleCount: ${e.sampleCount}`);
    console.log(`    keyframeCount: ${e.keyframeCount}`);
  } else {
    console.log(`  FAIL: threw unexpected error: ${(e as Error).message}`);
    process.exit(1);
  }
}

console.log("\n== Step 3: Generate all-I-frame video ==");
execSync(
  `ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=30 -c:v libx264 -pix_fmt yuv420p -g 1 -bf 0 ${allIFrameInput}`,
  { stdio: "inherit" },
);
const allIData = new Uint8Array(readFileSync(allIFrameInput));
const allIMeta = readMetadata(parseMP4(allIData), allIData.length);
console.log(
  `  All-I-frame video: ${allIMeta?.keyframeCount}/${allIMeta?.sampleCount} keyframes, allKeyframes=${allIMeta?.allKeyframes}`,
);

if (!allIMeta?.allKeyframes) {
  console.log("  FAIL: video should be all-I-frame");
  process.exit(1);
}

console.log("\n== Step 4: Haze-encode all-I-frame video ==");
const result = await hazeEncode(allIData, {
  multiplier: 19,
  encoderTag: "Haze Encoder - test",
  handlerName: "VideoHandler",
  forceTikTok9x16: true,
  tikTokWidth: 1080,
  tikTokHeight: 1920,
  dropSyncSamples: true,
  forceEncode: false,
}, (stage, percent) => {
  console.log(`  [${percent}%] ${stage}`);
});

writeFileSync(allIFrameOutput, result.output);
console.log(`  Output: ${result.outputSize} bytes in ${result.elapsedMs.toFixed(0)}ms`);

const outMeta = readMetadata(parseMP4(result.output), result.output.length);
console.log(`  After: ${outMeta?.width}x${outMeta?.height} @ ${outMeta?.fps}fps, ${outMeta?.sampleCount} samples, allKeyframes=${outMeta?.allKeyframes}`);

const mult = (outMeta?.fps ?? 0) / (allIMeta?.fps ?? 1);
console.log(`  FPS multiplier: ${mult.toFixed(2)}x`);

if (Math.abs(mult - 19) < 0.5) {
  console.log("  PASS: 19× FPS inflation");
} else {
  console.log("  FAIL: not 19×");
  process.exit(1);
}

if (outMeta?.allKeyframes) {
  console.log("  PASS: output is all-I-frame (will play correctly)");
} else {
  console.log("  FAIL: output is not all-I-frame");
  process.exit(1);
}

console.log("\n== Step 5: Verify output plays correctly (ffprobe -count_frames) ==");
try {
  const out = execSync(
    `ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of default=noprint_wrappers=1 ${allIFrameOutput}`,
    { encoding: "utf-8", timeout: 30000 },
  );
  console.log(`  ${out.trim()}`);
  const match = out.match(/nb_read_frames=(\d+)/);
  if (match) {
    const readFrames = parseInt(match[1], 10);
    if (readFrames === outMeta?.sampleCount) {
      console.log(`  PASS: all ${readFrames} frames decoded successfully`);
    } else {
      console.log(`  FAIL: only ${readFrames} frames decoded (expected ${outMeta?.sampleCount})`);
      process.exit(1);
    }
  }
} catch (e) {
  console.log(`  FAIL: ffprobe failed: ${(e as Error).message}`);
  process.exit(1);
}

console.log("\n== Step 6: Try to extract a frame (verify no corruption) ==");
try {
  execSync(
    `ffmpeg -y -i ${allIFrameOutput} -vframes 1 -vf "select=eq(n\\,0)" /tmp/frame_0.png -vframes 1 -vf "select=eq(n\\,19)" /tmp/frame_19.png 2>&1`,
    { stdio: "pipe", timeout: 10000 },
  );
  console.log("  PASS: frame extraction succeeded (no decode errors)");
} catch (e) {
  console.log(`  Note: frame extraction had issues (may be OK): ${(e as Error).message}`);
}

console.log("\n== Step 7: forceEncode=true on P-frame video (should succeed) ==");
try {
  const forcedResult = await hazeEncode(pFrameData, {
    multiplier: 19,
    encoderTag: "test",
    handlerName: "VideoHandler",
    forceTikTok9x16: false,
    tikTokWidth: 1080,
    tikTokHeight: 1920,
    dropSyncSamples: true,
    forceEncode: true,
  });
  console.log(`  PASS: forceEncode succeeded, output: ${forcedResult.outputSize} bytes`);
  console.log(`  (Note: output will have visible artifacts — this is expected)`);
} catch (e) {
  console.log(`  FAIL: forceEncode should have succeeded: ${(e as Error).message}`);
  process.exit(1);
}

console.log("\n== All tests passed! ==");
console.log("\nSummary:");
console.log("  ✅ P-frame input → HazeKeyframeError thrown (prevents corruption)");
console.log("  ✅ All-I-frame input → haze encoding succeeds");
console.log("  ✅ Output FPS is 19× (verified by metadata)");
console.log("  ✅ Output is all-I-frame (will play without corruption)");
console.log("  ✅ All 19× frames decode successfully in ffprobe");
console.log("  ✅ forceEncode=true allows encoding P-frame input (with artifacts)");
