/**
 * Test header patch with 1080p and 4K videos to verify no truncation.
 */

import { writeFileSync } from "fs";
import { execSync } from "child_process";
import { hazeEncode } from "/home/z/my-project/src/lib/mp4/index.ts";
import { readFileSync } from "fs";

async function testVideo(label: string, ffmpegArgs: string, inputFile: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Testing: ${label}`);
  console.log(`${"=".repeat(60)}`);

  console.log(`Generating: ffmpeg ${ffmpegArgs}`);
  execSync(`ffmpeg -y ${ffmpegArgs} ${inputFile}`, { stdio: "pipe" });

  const data = new Uint8Array(readFileSync(inputFile));

  console.log("Haze encoding (header_patch mode)...");
  const result = await hazeEncode(data, {
    mode: "header_patch",
    multiplier: 19,
    encoderTag: "Haze Encoder - test",
    handlerName: "VideoHandler",
    forceTikTok9x16: true,
    tikTokWidth: 1080,
    tikTokHeight: 1920,
    dropSyncSamples: true,
    forceEncode: false,
    autoPreprocess: false,
  });

  const outputFile = inputFile.replace(".mp4", "_haze.mp4");
  writeFileSync(outputFile, result.output);

  console.log(`Output: ${result.outputSize} bytes in ${result.elapsedMs.toFixed(0)}ms`);

  // Check ffprobe duration
  const durationOut = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 ${outputFile}`,
    { encoding: "utf-8" },
  ).trim();
  console.log(`ffprobe format duration: ${durationOut}`);

  const inputDurationOut = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 ${inputFile}`,
    { encoding: "utf-8" },
  ).trim();
  console.log(`Input duration: ${inputDurationOut}`);

  // Full decode test
  try {
    execSync(`ffmpeg -v error -i ${outputFile} -f null -`, { stdio: "pipe", timeout: 60000 });
    console.log("✅ Full decode succeeded (no corruption)");
  } catch (e) {
    console.log("❌ Decode failed");
    return false;
  }

  // Extract last frame to verify
  const streamInfo = execSync(
    `ffprobe -v error -show_entries stream=nb_frames -of default=noprint_wrappers=1 ${outputFile}`,
    { encoding: "utf-8" },
  ).trim();
  const match = streamInfo.match(/nb_frames=(\d+)/);
  if (match) {
    const lastFrame = parseInt(match[1], 10) - 1;
    try {
      execSync(
        `ffmpeg -y -v error -i ${outputFile} -vf "select=eq(n\\,${lastFrame})" -vframes 1 /tmp/lastframe_${label}.png`,
        { stdio: "pipe", timeout: 30000 },
      );
      console.log(`✅ Last frame (${lastFrame}) extracted successfully`);
    } catch (e) {
      console.log(`❌ Last frame extraction failed`);
      return false;
    }
  }

  return true;
}

const allPass = await Promise.all([
  testVideo(
    "1080p_10s",
    "-f lavfi -i testsrc=duration=10:size=1920x1080:rate=30 -c:v libx264 -pix_fmt yuv420p -g 60",
    "/tmp/test_1080p.mp4",
  ),
  testVideo(
    "4K_5s",
    "-f lavfi -i testsrc=duration=5:size=3840x2160:rate=30 -c:v libx264 -pix_fmt yuv420p -g 60",
    "/tmp/test_4k.mp4",
  ),
]);

if (allPass.every(Boolean)) {
  console.log("\n✅ All video tests passed!");
} else {
  console.log("\n❌ Some tests failed");
  process.exit(1);
}
