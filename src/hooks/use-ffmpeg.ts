"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

/**
 * Hook to load and use ffmpeg.wasm in the browser.
 *
 * The ffmpeg core is loaded lazily on first use and cached for the lifetime
 * of the component. Loading takes ~5-10 seconds (downloading ~30MB WASM file)
 * but only happens once per page load.
 *
 * Uses the single-threaded core (@ffmpeg/core) which works without
 * SharedArrayBuffer/COOP-COEP headers — at the cost of slower encoding.
 */

export type FfmpegLoadState = "idle" | "loading" | "loaded" | "error";

export interface FfmpegProgress {
  progress: number; // 0..1
  time: number; // microseconds
}

export interface UseFfmpegResult {
  /** Current load state. */
  state: FfmpegLoadState;
  /** Error message if loading failed. */
  error: string | null;
  /** The FFmpeg instance (null until loaded). */
  ffmpeg: FFmpeg | null;
  /** Load ffmpeg if not already loaded. Returns the FFmpeg instance. */
  load: () => Promise<FFmpeg | null>;
  /**
   * Convert an input video file to all-I-frame MP4 using ffmpeg.wasm.
   *
   * @param file Input video File or Uint8Array
   * @param onProgress Optional progress callback (0..1)
   * @param onLog Optional log callback
   * @returns Output MP4 as Uint8Array
   */
  convertToAllIFrames: (
    file: File | Uint8Array,
    onProgress?: (p: FfmpegProgress) => void,
    onLog?: (message: string) => void,
  ) => Promise<Uint8Array>;
}

// CDN URLs for the ffmpeg-core single-threaded build.
// We use unpkg as the primary CDN. The toBlobURL call fetches the file and
// creates a same-origin blob URL, which avoids CORS issues when loading the
// WASM file into the Web Worker.
const FFMPEG_CORE_VERSION = "0.12.6";
const FFMPEG_CORE_BASE = `https://unpkg.com/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/umd`;

export function useFfmpeg(): UseFfmpegResult {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const [state, setState] = useState<FfmpegLoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<FFmpeg | null> => {
    if (ffmpegRef.current?.loaded) {
      setState("loaded");
      return ffmpegRef.current;
    }
    if (state === "loading") return null;

    setState("loading");
    setError(null);

    try {
      const ffmpeg = new FFmpeg();

      // Fetch the core JS and WASM files as blob URLs to avoid CORS issues
      const coreURL = await toBlobURL(
        `${FFMPEG_CORE_BASE}/ffmpeg-core.js`,
        "text/javascript",
      );
      const wasmURL = await toBlobURL(
        `${FFMPEG_CORE_BASE}/ffmpeg-core.wasm`,
        "application/wasm",
      );

      await ffmpeg.load({ coreURL, wasmURL });
      ffmpegRef.current = ffmpeg;
      setState("loaded");
      return ffmpeg;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Failed to load ffmpeg: ${msg}`);
      setState("error");
      return null;
    }
  }, [state]);

  const convertToAllIFrames = useCallback(
    async (
      file: File | Uint8Array,
      onProgress?: (p: FfmpegProgress) => void,
      onLog?: (message: string) => void,
    ): Promise<Uint8Array> => {
      const ffmpeg = await load();
      if (!ffmpeg) {
        throw new Error("ffmpeg not loaded");
      }

      // Set up progress and log listeners
      const progressHandler = (p: FfmpegProgress) => onProgress?.(p);
      const logHandler = (e: { message: string }) => onLog?.(e.message);
      ffmpeg.on("progress", progressHandler);
      ffmpeg.on("log", logHandler);

      try {
        // fetchFile only handles string, URL, File, Blob — not Uint8Array.
        // If we got a Uint8Array, wrap it in a Blob first.
        const inputFile =
          file instanceof Uint8Array
            ? new Blob([file as BlobPart], { type: "video/mp4" })
            : file;
        const inputData = await fetchFile(inputFile);
        await ffmpeg.writeFile("input.mp4", inputData);

        // Collect log messages for error reporting
        const logMessages: string[] = [];
        const logCollector = (e: { message: string }) => {
          logMessages.push(e.message);
          onLog?.(e.message);
        };
        ffmpeg.on("log", logCollector);

        // Convert to all-I-frame:
        //   -g 1     → GOP size 1 (every frame is a keyframe)
        //   -bf 0    → no B-frames
        //   -c:v libx264 → H.264 codec
        //   -preset fast → reasonable speed/size tradeoff
        //   -crf 18  → high quality
        //   -an      → drop audio (we only need video for haze encoding)
        //              (audio can be re-muxed if needed, but for haze encoding
        //              the video metadata is what matters)
        //   -pix_fmt yuv420p → compatible pixel format
        const exitCode = await ffmpeg.exec([
          "-i",
          "input.mp4",
          "-g",
          "1",
          "-bf",
          "0",
          "-c:v",
          "libx264",
          "-preset",
          "fast",
          "-crf",
          "18",
          "-pix_fmt",
          "yuv420p",
          "-an",
          "output.mp4",
        ]);

        if (exitCode !== 0) {
          // Get the last ~30 lines of log for debugging
          const recentLogs = logMessages.slice(-30).join("\n");
          throw new Error(
            `ffmpeg exited with code ${exitCode}. Recent log:\n${recentLogs}`,
          );
        }

        const outputData = await ffmpeg.readFile("output.mp4");
        // Cleanup the virtual filesystem
        try {
          await ffmpeg.deleteFile("input.mp4");
          await ffmpeg.deleteFile("output.mp4");
        } catch {
          // Ignore cleanup errors
        }
        ffmpeg.off("log", logCollector);

        // outputData is Uint8Array | string; cast appropriately
        if (typeof outputData === "string") {
          throw new Error("Unexpected string output from ffmpeg");
        }
        return outputData as Uint8Array;
      } finally {
        ffmpeg.off("progress", progressHandler);
        ffmpeg.off("log", logHandler);
      }
    },
    [load],
  );

  // Clean up on unmount
  useEffect(() => {
    return () => {
      ffmpegRef.current = null;
    };
  }, []);

  return {
    state,
    error,
    ffmpeg: ffmpegRef.current,
    load,
    convertToAllIFrames,
  };
}
