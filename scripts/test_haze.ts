/**
 * Test script for the haze encoder.
 * Generates a small test MP4, runs the haze encoder, and verifies the output.
 */

import { writeFileSync } from "fs";
import { execSync } from "child_process";

// Generate a test MP4 (small 2-second video at 30fps, 320x240)
const testFile = "/tmp/test_input.mp4";
const outputFile = "/tmp/test_output.mp4";

console.log("== Generating test MP4 ==");
execSync(
  `ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=30 -c:v libx264 -pix_fmt yuv420p -g 60 ${testFile}`,
  { stdio: "inherit" },
);

console.log("\n== Input file info ==");
execSync(
  `ffprobe -v error -show_entries stream=nb_frames,avg_frame_rate,r_frame_rate -of default=noprint_wrappers=1 ${testFile}`,
  { stdio: "inherit" },
);

console.log("\n== Running haze encoder via bun ==");
const scriptContent = `
import { hazeEncode, parseMP4, readMetadata } from "/home/z/my-project/src/lib/mp4/index.ts";
import { readFileSync, writeFileSync } from "fs";

const data = new Uint8Array(readFileSync("${testFile}"));
console.log("Input size:", data.length, "bytes");

const result = await hazeEncode(data, {
  multiplier: 19,
  encoderTag: "Haze Encoder - test",
  handlerName: "VideoHandler",
  forceTikTok9x16: true,
  tikTokWidth: 1080,
  tikTokHeight: 1920,
  dropSyncSamples: true,
}, (stage, percent) => {
  console.log("  [" + percent + "%] " + stage);
});

writeFileSync("${outputFile}", result.output);
console.log("Output size:", result.outputSize, "bytes");
console.log("Elapsed:", (result.elapsedMs / 1000).toFixed(2), "s");

// Verify by reading back metadata
const beforeBoxes = parseMP4(data);
const before = readMetadata(beforeBoxes, data.length);
const afterBoxes = parseMP4(result.output);
const after = readMetadata(afterBoxes, result.output.length);

console.log("\\n== Before ==");
console.log("  Resolution:", before?.width + "x" + before?.height);
console.log("  r_frame_rate:", before?.fps.toFixed(3), "fps");
console.log("  avg_frame_rate:", before?.avgFps.toFixed(3), "fps");
console.log("  Timescale:", before?.timescale);
console.log("  Sample count:", before?.sampleCount);
console.log("  Duration:", before?.duration.toFixed(3), "s");
console.log("  moov at end:", before?.moovAtEnd);

console.log("\\n== After ==");
console.log("  Resolution:", after?.width + "x" + after?.height);
console.log("  r_frame_rate:", after?.fps.toFixed(3), "fps");
console.log("  avg_frame_rate:", after?.avgFps.toFixed(3), "fps");
console.log("  Timescale:", after?.timescale);
console.log("  Sample count:", after?.sampleCount);
console.log("  Duration:", after?.duration.toFixed(3), "s");
console.log("  moov at end:", after?.moovAtEnd);
console.log("  Encoder tag:", after?.encoderTag);

const mult = (after?.fps ?? 0) / (before?.fps ?? 1);
console.log("\\n== FPS multiplier ==", mult.toFixed(2) + "x");
if (Math.abs(mult - 19) < 0.5) {
  console.log("PASS: FPS inflated 19x");
} else {
  console.log("FAIL: FPS not inflated 19x");
  process.exit(1);
}

if (after?.moovAtEnd) {
  console.log("PASS: moov at end (faststart OFF)");
} else {
  console.log("FAIL: moov not at end");
  process.exit(1);
}

if (after?.width === 1080 && after?.height === 1920) {
  console.log("PASS: TikTok 9:16 dimensions");
} else {
  console.log("FAIL: not 9:16");
  process.exit(1);
}

if (after?.encoderTag === "Haze Encoder - test") {
  console.log("PASS: encoder tag set");
} else {
  console.log("FAIL: encoder tag not set");
  process.exit(1);
}

console.log("\\nAll tests passed!");
`;

writeFileSync("/tmp/run_haze.ts", scriptContent);
execSync("bun /tmp/run_haze.ts", { stdio: "inherit" });

console.log("\n== Output file stream info ==");
execSync(
  `ffprobe -v error -show_entries stream=nb_frames,avg_frame_rate,r_frame_rate,width,height -of default=noprint_wrappers=1 ${outputFile}`,
  { stdio: "inherit" },
);

console.log("\n== Output file format info ==");
execSync(
  `ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 ${outputFile}`,
  { stdio: "inherit" },
);

// Check moov position in output
console.log("\n== Output box layout ==");
execSync(
  `grep -aoE '[a-z][a-z0-9]{3}' ${outputFile} | head -20 | uniq -c`,
  { stdio: "inherit" },
);
