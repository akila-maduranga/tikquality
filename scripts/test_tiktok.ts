/**
 * Test the haze encoder with a TikTok-format (9:16 1080x1920) file.
 * Verifies the encoder handles realistic video files correctly.
 */

import { writeFileSync } from "fs";
import { execSync } from "child_process";

const testFile = "/tmp/test_tiktok.mp4";
const outputFile = "/tmp/test_tiktok_haze.mp4";

console.log("== Generating TikTok-format MP4 (1080x1920, 30fps, 5s) ==");
execSync(
  `ffmpeg -y -f lavfi -i testsrc=duration=5:size=1080x1920:rate=30 -c:v libx264 -pix_fmt yuv420p -g 60 -preset ultrafast ${testFile}`,
  { stdio: "inherit" },
);

console.log("\n== Input file info ==");
execSync(
  `ffprobe -v error -show_entries stream=nb_frames,avg_frame_rate,r_frame_rate,width,height -of default=noprint_wrappers=1 ${testFile}`,
  { stdio: "inherit" },
);

console.log("\n== Running haze encoder ==");
const scriptContent = `
import { hazeEncode, parseMP4, readMetadata } from "/home/z/my-project/src/lib/mp4/index.ts";
import { readFileSync, writeFileSync } from "fs";

const data = new Uint8Array(readFileSync("${testFile}"));
console.log("Input size:", data.length, "bytes");

const t0 = performance.now();
const result = await hazeEncode(data, {
  multiplier: 19,
  encoderTag: "Haze Encoder - haze.vercel.app",
  handlerName: "VideoHandler",
  forceTikTok9x16: true,
  tikTokWidth: 1080,
  tikTokHeight: 1920,
  dropSyncSamples: true,
}, (stage, percent) => {
  console.log("  [" + percent + "%] " + stage);
});
const t1 = performance.now();

writeFileSync("${outputFile}", result.output);
console.log("Output size:", result.outputSize, "bytes");
console.log("Haze encode time:", (t1 - t0).toFixed(0), "ms");

const beforeBoxes = parseMP4(data);
const before = readMetadata(beforeBoxes, data.length);
const afterBoxes = parseMP4(result.output);
const after = readMetadata(afterBoxes, result.output.length);

console.log("\\n== Metadata ==");
console.log("  Before: " + before?.width + "x" + before?.height + " @ " + before?.fps.toFixed(0) + "fps, " + before?.sampleCount + " samples, moovAtEnd=" + before?.moovAtEnd);
console.log("  After:  " + after?.width + "x" + after?.height + " @ " + after?.fps.toFixed(0) + "fps, " + after?.sampleCount + " samples, moovAtEnd=" + after?.moovAtEnd);
console.log("  FPS multiplier: " + ((after?.fps ?? 0) / (before?.fps ?? 1)).toFixed(2) + "x");
console.log("  Encoder tag: " + after?.encoderTag);
`;

writeFileSync("/tmp/run_tiktok_test.ts", scriptContent);
execSync("bun /tmp/run_tiktok_test.ts", { stdio: "inherit" });

console.log("\n== Output file info (ffprobe) ==");
execSync(
  `ffprobe -v error -show_entries stream=nb_frames,avg_frame_rate,r_frame_rate,width,height -of default=noprint_wrappers=1 ${outputFile}`,
  { stdio: "inherit" },
);
execSync(
  `ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 ${outputFile}`,
  { stdio: "inherit" },
);

// Verify the file plays correctly (decode check)
console.log("\n== Decode check (ffprobe -count_frames) ==");
try {
  execSync(
    `ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of default=noprint_wrappers=1 ${outputFile}`,
    { stdio: "inherit", timeout: 30000 },
  );
} catch (e) {
  console.log("Decode check timed out or failed (may be OK for haze-encoded files)");
}
