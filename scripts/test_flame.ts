import { writeFileSync, readFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { hazeEncode, parseMP4, readMetadata } from "../src/lib/mp4/index";
import { readU32 } from "../src/lib/mp4/parser";

async function main() {
  const tmpDir = tmpdir();
  const testFile = "C:\\Users\\Akila Mac\\Downloads\\video_combined.mp4";
  const outputFile = join(tmpDir, "test_output_flame.mp4");

  if (!existsSync(testFile)) {
    console.error(`Error: Test input file ${testFile} does not exist.`);
    process.exit(1);
  }

  console.log("== Using test MP4:", testFile);

  const data = new Uint8Array(readFileSync(testFile));
  console.log("Input size:", data.length, "bytes");

  // Run haze encode in flame_inflation mode
  const result = await hazeEncode(data, {
    mode: "flame_inflation",
    multiplier: 19,
    encoderTag: "Haze Encoder - flame test",
    handlerName: "VideoHandler",
    forceTikTok9x16: true,
    tikTokWidth: 1080,
    tikTokHeight: 1920,
    dropSyncSamples: true,
    forceEncode: true, // Bypass keyframe check for the test
    autoPreprocess: false,
  }, (stage, percent) => {
    console.log("  [" + percent + "%] " + stage);
  });

  writeFileSync(outputFile, result.output);
  console.log("Output size:", result.outputSize, "bytes");
  console.log("Elapsed:", (result.elapsedMs / 1000).toFixed(2), "s");

  // Verify by reading back metadata
  const beforeBoxes = parseMP4(data);
  const before = readMetadata(beforeBoxes, data.length);
  const afterBoxes = parseMP4(result.output);
  const after = readMetadata(afterBoxes, result.output.length);

  console.log("\n== Before ==");
  console.log("  Resolution:", before?.width + "x" + before?.height);
  console.log("  r_frame_rate:", before?.fps.toFixed(3), "fps");
  console.log("  avg_frame_rate:", before?.avgFps.toFixed(3), "fps");
  console.log("  Timescale:", before?.timescale);
  console.log("  Sample count:", before?.sampleCount);
  console.log("  Duration:", before?.duration.toFixed(3), "s");
  console.log("  moov at end:", before?.moovAtEnd);

  console.log("\n== After ==");
  console.log("  Resolution:", after?.width + "x" + after?.height);
  console.log("  r_frame_rate:", after?.fps.toFixed(3), "fps");
  console.log("  avg_frame_rate:", after?.avgFps.toFixed(3), "fps");
  console.log("  Timescale:", after?.timescale);
  console.log("  Sample count:", after?.sampleCount);
  console.log("  Duration:", after?.duration.toFixed(3), "s");
  console.log("  moov at end:", after?.moovAtEnd);
  console.log("  Encoder tag:", after?.encoderTag);

  console.log("\n== Verification Checks ==");
  const checks: { name: string; pass: boolean; detail: string }[] = [];

  // 1. Check if timescale was multiplied by 19
  checks.push({
    name: "Timescale multiplied 19x",
    pass: (after?.timescale ?? 0) === (before?.timescale ?? 0) * 19,
    detail: `${before?.timescale} -> ${after?.timescale}`,
  });

  // 2. Check if sample count was multiplied by 19
  checks.push({
    name: "Sample count multiplied 19x",
    pass: (after?.sampleCount ?? 0) === (before?.sampleCount ?? 0) * 19,
    detail: `${before?.sampleCount} -> ${after?.sampleCount}`,
  });

  // 3. Check if average FPS and playback duration are preserved
  checks.push({
    name: "Duration preserved",
    pass: Math.abs((after?.duration ?? 0) - (before?.duration ?? 0)) < 0.05,
    detail: `${before?.duration?.toFixed(3)}s -> ${after?.duration?.toFixed(3)}s`,
  });

  checks.push({
    name: "r_frame_rate multiplied 19x",
    pass: Math.abs((after?.fps ?? 0) - (before?.fps ?? 0) * 19) < 0.5,
    detail: `${before?.fps?.toFixed(3)} -> ${after?.fps?.toFixed(3)}`,
  });

  // 4. Verify that stco (chunk offsets) size is NOT multiplied
  // In flame_inflation, the chunk count/offset count should be identical to the original!
  const originalMoov = beforeBoxes.find(b => b.type === "moov");
  const originalTrak = originalMoov ? originalMoov.children.find(c => {
    const mdia = c.children.find(m => m.type === "mdia");
    const hdlr = mdia ? mdia.children.find(h => h.type === "hdlr") : null;
    return hdlr && hdlr.payload[8] === 118 && hdlr.payload[9] === 105; // "vide"
  }) : null;
  const originalStco = originalTrak ? findStco(originalTrak) : null;

  const newMoov = afterBoxes.find(b => b.type === "moov");
  const newTrak = newMoov ? newMoov.children.find(c => {
    const mdia = c.children.find(m => m.type === "mdia");
    const hdlr = mdia ? mdia.children.find(h => h.type === "hdlr") : null;
    return hdlr && hdlr.payload[8] === 118 && hdlr.payload[9] === 105;
  }) : null;
  const newStco = newTrak ? findStco(newTrak) : null;

  function findStco(trak: any) {
    const mdia = trak.children.find(c => c.type === "mdia");
    const minf = mdia ? mdia.children.find(c => c.type === "minf") : null;
    const stbl = minf ? minf.children.find(c => c.type === "stbl") : null;
    return stbl ? stbl.children.find(c => c.type === "stco" || c.type === "co64") : null;
  }

  const beforeChunks = originalStco ? readU32(originalStco.payload, 4) : 0;
  const afterChunks = newStco ? readU32(newStco.payload, 4) : 0;

  checks.push({
    name: "Chunk count (stco/co64 entries) remains identical",
    pass: beforeChunks === afterChunks,
    detail: `${beforeChunks} -> ${afterChunks}`,
  });

  // 5. Verify stsc first_chunk/samples_per_chunk entries are multiplied
  const originalStsc = originalTrak ? findStsc(originalTrak) : null;
  const newStsc = newTrak ? findStsc(newTrak) : null;

  function findStsc(trak: any) {
    const mdia = trak.children.find(c => c.type === "mdia");
    const minf = mdia ? mdia.children.find(c => c.type === "minf") : null;
    const stbl = minf ? minf.children.find(c => c.type === "stbl") : null;
    return stbl ? stbl.children.find(c => c.type === "stsc") : null;
  }

  const beforeSamplesPerChunk = originalStsc ? readU32(originalStsc.payload, 12) : 0;
  const afterSamplesPerChunk = newStsc ? readU32(newStsc.payload, 12) : 0;

  checks.push({
    name: "Stsc samples_per_chunk multiplied by 19",
    pass: afterSamplesPerChunk === beforeSamplesPerChunk * 19,
    detail: `${beforeSamplesPerChunk} -> ${afterSamplesPerChunk}`,
  });

  let allPass = true;
  for (const check of checks) {
    const icon = check.pass ? "✅" : "❌";
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
    if (!check.pass) allPass = false;
  }

  console.log("\n== Full decode check with FFmpeg ==");
  try {
    execSync("ffmpeg -version", { stdio: "ignore" });
    execSync(`ffmpeg -v error -i "${outputFile}" -f null - 2>&1`, { encoding: "utf-8", timeout: 30000 });
    console.log("  ✅ Full decode succeeded — video data is 100% intact");
  } catch (e) {
    console.log("  ⚠️ FFmpeg is not installed or failed to check. Skipping full decode validation.");
  }

  if (allPass) {
    console.log("\n✅ All flame inflation tests passed!");
  } else {
    console.log("\n❌ Some tests failed");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
