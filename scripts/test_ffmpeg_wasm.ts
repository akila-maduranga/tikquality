/**
 * Test ffmpeg.wasm in Node.js to verify the conversion works.
 * Note: ffmpeg.wasm is designed for browsers, but bun can run it too.
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { readFileSync, writeFileSync } from "fs";

const FFMPEG_CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

console.log("Loading ffmpeg.wasm...");
const ffmpeg = new FFmpeg();

try {
  const coreURL = await toBlobURL(
    `${FFMPEG_CORE_BASE}/ffmpeg-core.js`,
    "text/javascript",
  );
  const wasmURL = await toBlobURL(
    `${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`,
    "application/wasm",
  );
  console.log("Core URL fetched, loading ffmpeg...");
  await ffmpeg.load({ coreURL, wasmURL });
  console.log("ffmpeg loaded");
} catch (e) {
  console.log("Failed to load ffmpeg in node:", e.message);
  process.exit(1);
}

ffmpeg.on("log", ({ message }) => {
  console.log("[ffmpeg]", message);
});

ffmpeg.on("progress", ({ progress }) => {
  console.log(`[progress] ${(progress * 100).toFixed(1)}%`);
});

// Use the P-frame test file
const inputData = new Uint8Array(readFileSync("/tmp/test_pframes.mp4"));
console.log("Input size:", inputData.length);

await ffmpeg.writeFile("input.mp4", inputData);

console.log("Running ffmpeg -i input.mp4 -g 1 -bf 0 -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -an output.mp4");
const exitCode = await ffmpeg.exec([
  "-i", "input.mp4",
  "-g", "1",
  "-bf", "0",
  "-c:v", "libx264",
  "-preset", "fast",
  "-crf", "18",
  "-pix_fmt", "yuv420p",
  "-an",
  "output.mp4",
]);

console.log("Exit code:", exitCode);

if (exitCode === 0) {
  const outputData = await ffmpeg.readFile("output.mp4");
  writeFileSync("/tmp/test_wasm_output.mp4", outputData);
  console.log("Output size:", outputData.length);
  console.log("Output saved to /tmp/test_wasm_output.mp4");
} else {
  console.log("ffmpeg failed");
}
