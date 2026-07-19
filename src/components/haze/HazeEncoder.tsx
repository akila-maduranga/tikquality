"use client";

import { useCallback, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  CloudFog,
  FileVideo,
  Upload,
  Download,
  Play,
  Loader2,
  Settings2,
  Zap,
  Info,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Film,
  Clock,
  Gauge,
  Monitor,
  Key,
  Terminal,
  Copy,
} from "lucide-react";
import {
  DEFAULT_OPTIONS,
  HazeKeyframeError,
  HazeOptions,
  VideoMetadata,
  formatBytes,
  formatDuration,
  hazeEncode,
  parseMP4,
  readMetadata,
} from "@/lib/mp4";
import { useFfmpeg } from "@/hooks/use-ffmpeg";

interface ProgressState {
  stage: string;
  percent: number;
}

interface PreprocessInfo {
  originalSize: number;
  preprocessedSize: number;
  preprocessedMeta: VideoMetadata | null;
  elapsedMs: number;
}

export function HazeEncoder() {
  const [file, setFile] = useState<File | null>(null);
  const [originalMeta, setOriginalMeta] = useState<VideoMetadata | null>(null);
  const [encodedMeta, setEncodedMeta] = useState<VideoMetadata | null>(null);
  const [options, setOptions] = useState<HazeOptions>(DEFAULT_OPTIONS);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [progress, setProgress] = useState<ProgressState>({
    stage: "",
    percent: 0,
  });
  const [outputBlob, setOutputBlob] = useState<Blob | null>(null);
  const [outputUrl, setOutputUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyframeError, setKeyframeError] = useState<HazeKeyframeError | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [preprocessInfo, setPreprocessInfo] = useState<PreprocessInfo | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ffmpeg = useFfmpeg();

  const handleFile = useCallback(async (file: File) => {
    setFile(file);
    setError(null);
    setKeyframeError(null);
    setOutputBlob(null);
    setOutputUrl(null);
    setEncodedMeta(null);
    setElapsedMs(null);
    setOriginalMeta(null);
    setPreprocessInfo(null);

    if (!file.type.startsWith("video/") && !file.name.toLowerCase().endsWith(".mp4")) {
      setError("Please select an MP4 video file.");
      return;
    }

    setIsReading(true);
    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const boxes = parseMP4(buffer);
      const meta = readMetadata(boxes, file.size);
      setOriginalMeta(meta);
      if (!meta) {
        setError(
          "Could not read MP4 metadata. Make sure this is a valid MP4 file (not WebM, MKV, etc).",
        );
      }
    } catch (e) {
      setError(`Failed to read file: ${(e as Error).message}`);
    } finally {
      setIsReading(false);
    }
  }, []);

  const handleEncode = useCallback(async () => {
    if (!file) return;
    setIsProcessing(true);
    setError(null);
    setKeyframeError(null);
    setProgress({ stage: "Starting...", percent: 0 });
    setOutputBlob(null);
    setOutputUrl(null);
    setEncodedMeta(null);
    setPreprocessInfo(null);

    try {
      let inputBuffer = new Uint8Array(await file.arrayBuffer());
      let inputMeta = originalMeta;

      // Stage 1: auto-preprocess to all-I-frame if needed (frame_inflation / flame_inflation modes)
      // Header Patch mode doesn't need pre-processing — it doesn't touch sample tables.
      const needsPreprocess =
        (options.mode === "frame_inflation" || options.mode === "flame_inflation") &&
        options.autoPreprocess &&
        inputMeta &&
        !inputMeta.allKeyframes;

      if (needsPreprocess) {
        setProgress({ stage: "Loading ffmpeg.wasm (one-time, ~30MB)", percent: 5 });
        const preprocStart = performance.now();

        // Convert to all-I-frame using ffmpeg.wasm
        const preprocBuffer = await ffmpeg.convertToAllIFrames(
          inputBuffer,
          (p) => {
            // ffmpeg progress is 0..1 over the encoding duration
            // Map to 10..70 percent (preprocess stage)
            const pct = Math.min(70, Math.max(10, 10 + p.progress * 60));
            setProgress({
              stage: `Converting to all-I-frame with ffmpeg.wasm (${(p.progress * 100).toFixed(0)}%)`,
              percent: Math.round(pct),
            });
          },
          (msg) => {
            // Optionally surface ffmpeg log messages
            if (msg && !msg.startsWith("frame=")) {
              // Could store in state if we want to show logs
            }
          },
        );

        const preprocElapsed = performance.now() - preprocStart;
        const preprocMeta = readMetadata(
          parseMP4(preprocBuffer),
          preprocBuffer.length,
        );

        setPreprocessInfo({
          originalSize: inputBuffer.length,
          preprocessedSize: preprocBuffer.length,
          preprocessedMeta: preprocMeta,
          elapsedMs: preprocElapsed,
        });

        // Use the preprocessed buffer for haze encoding
        inputBuffer = preprocBuffer;
        inputMeta = preprocMeta;

        setProgress({ stage: "All-I-frame conversion complete", percent: 75 });
      }

      // Stage 2: haze encode (metadata only)
      // If autoPreprocess ran, forceEncode is effectively true now (input is all-I-frame).
      // If autoPreprocess is off but forceEncode is on, just call hazeEncode with forceEncode.
      // If both are off and input has P/B-frames, hazeEncode will throw HazeKeyframeError.
      const hazeOptions: HazeOptions = {
        ...options,
        // If we preprocessed, force the encode flag on so the guard doesn't trip
        forceEncode: needsPreprocess ? true : options.forceEncode,
      };

      const result = await hazeEncode(inputBuffer, hazeOptions, (stage, percent) => {
        // Map haze encode progress to 75..100 if we preprocessed, else 0..100
        const mapped = needsPreprocess
          ? 75 + Math.round((percent / 100) * 25)
          : percent;
        setProgress({ stage, percent: mapped });
      });

      const blob = new Blob([result.output as BlobPart], { type: "video/mp4" });
      setOutputBlob(blob);
      setOutputUrl(URL.createObjectURL(blob));
      setElapsedMs(result.elapsedMs);

      // Verify by reading back metadata
      const newBoxes = parseMP4(result.output);
      const newMeta = readMetadata(newBoxes, result.output.length);
      setEncodedMeta(newMeta);
    } catch (e) {
      if (e instanceof HazeKeyframeError) {
        setKeyframeError(e);
      } else {
        setError(`Encoding failed: ${(e as Error).message}`);
      }
    } finally {
      setIsProcessing(false);
    }
  }, [file, options, originalMeta, ffmpeg]);

  const copyFfmpegCommand = useCallback(() => {
    const cmd =
      "ffmpeg -i input.mp4 -g 1 -bf 0 -c:v libx264 -preset fast -crf 18 all_iframes.mp4";
    navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const handleDownload = useCallback(() => {
    if (!outputBlob || !file) return;
    const url = URL.createObjectURL(outputBlob);
    const a = document.createElement("a");
    a.href = url;
    const baseName = file.name.replace(/\.mp4$/i, "");
    a.download = `${baseName}_haze.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [outputBlob, file]);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragActive(false);
      const droppedFile = e.dataTransfer.files?.[0];
      if (droppedFile) handleFile(droppedFile);
    },
    [handleFile],
  );

  const fpsMultiplier = originalMeta && encodedMeta
    ? encodedMeta.fps / originalMeta.fps
    : 0;

  return (
    <div className="min-h-screen bg-background">
      {/* Hero */}
      <header className="border-b border-border bg-gradient-to-br from-background via-background to-muted/30">
        <div className="container mx-auto max-w-6xl px-4 py-12 md:py-20">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500 to-red-600 shadow-lg shadow-orange-500/20">
              <CloudFog className="h-7 w-7 text-white" />
            </div>
            <Badge variant="secondary" className="font-mono">
              v1.0 · metadata-only
            </Badge>
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            Haze Encoder
          </h1>
          <p className="mt-4 text-lg md:text-xl text-muted-foreground max-w-2xl">
            Metadata-level haze encoding for MP4 videos. Inflates the internal
            frame rate by{" "}
            <span className="font-mono text-foreground">19×</span>, disables
            faststart, embeds a custom encoder tag, and forces TikTok 9:16
            display — all without re-encoding a single frame.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Badge variant="outline" className="gap-1.5">
              <Zap className="h-3 w-3" /> Instant processing
            </Badge>
            <Badge variant="outline" className="gap-1.5">
              <Film className="h-3 w-3" /> 4K ready
            </Badge>
            <Badge variant="outline" className="gap-1.5">
              <Monitor className="h-3 w-3" /> 9:16 TikTok
            </Badge>
            <Badge variant="outline" className="gap-1.5">
              <Gauge className="h-3 w-3" /> 19× FPS inflation
            </Badge>
            <Badge variant="outline" className="gap-1.5">
              <CloudFog className="h-3 w-3" /> Vercel deployable
            </Badge>
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-6xl px-4 py-8 md:py-12 space-y-8">
        {/* File upload */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileVideo className="h-5 w-5" />
              Input video
            </CardTitle>
            <CardDescription>
              Drop an MP4 file here or click to browse. Everything runs in your
              browser — nothing is uploaded.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 cursor-pointer transition-colors ${
                dragActive
                  ? "border-orange-500 bg-orange-500/5"
                  : "border-border hover:border-muted-foreground/50"
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/quicktime,.mp4,.mov"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              {isReading ? (
                <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
              ) : file ? (
                <>
                  <FileVideo className="h-10 w-10 text-orange-500" />
                  <div className="text-center">
                    <p className="font-medium">{file.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {formatBytes(file.size)}
                      {originalMeta && (
                        <>
                          {" · "}
                          {originalMeta.width}×{originalMeta.height}
                          {" · "}
                          {originalMeta.fps.toFixed(2)} fps
                          {" · "}
                          {formatDuration(originalMeta.duration)}
                          {" · "}
                          {originalMeta.codec || "mp4v"}
                        </>
                      )}
                    </p>
                    {originalMeta && (
                      <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
                        {originalMeta.allKeyframes ? (
                          <Badge
                            variant="outline"
                            className="gap-1 border-emerald-500/50 text-emerald-700 dark:text-emerald-400"
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            All I-frames · haze-ready
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-400"
                          >
                            <AlertTriangle className="h-3 w-3" />
                            {originalMeta.keyframeCount}/{originalMeta.sampleCount} keyframes · P/B-frames present
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                  >
                    Choose different file
                  </Button>
                </>
              ) : (
                <>
                  <Upload className="h-10 w-10 text-muted-foreground" />
                  <div className="text-center">
                    <p className="font-medium">
                      Drop MP4 here or click to browse
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Supports 4K · 100% client-side · No upload
                    </p>
                  </div>
                </>
              )}
            </div>

            {error && (
              <Alert variant="destructive" className="mt-4">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {keyframeError && (
              <Alert className="mt-4 border-amber-500/50 bg-amber-500/5 text-amber-900 dark:text-amber-100">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <AlertTitle className="text-amber-900 dark:text-amber-100">
                  Input has P/B-frames — output would be corrupted
                </AlertTitle>
                <AlertDescription className="space-y-3 text-amber-900 dark:text-amber-100">
                  <p>
                    Your video has{" "}
                    <span className="font-mono font-semibold">
                      {keyframeError.keyframeCount}
                    </span>{" "}
                    keyframes out of{" "}
                    <span className="font-mono font-semibold">
                      {keyframeError.sampleCount}
                    </span>{" "}
                    samples. Haze encoding duplicates each sample 19× by pointing
                    multiple <code className="font-mono">stco</code> entries at
                    the same byte offset. For I-frames this produces 19 identical
                    frames (correct). For P-frames, the same motion delta is
                    applied 19 times in a row, compounding the motion and
                    producing visible corruption.
                  </p>
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                    <p className="text-xs font-medium mb-1.5 flex items-center gap-1.5">
                      <Terminal className="h-3 w-3" />
                      Pre-process your video to all-I-frame first:
                    </p>
                    <code className="block font-mono text-xs break-all">
                      ffmpeg -i input.mp4 -g 1 -bf 0 -c:v libx264 -preset fast -crf 18 all_iframes.mp4
                    </code>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-7 text-xs"
                      onClick={copyFfmpegCommand}
                    >
                      {copied ? (
                        <>
                          <CheckCircle2 className="h-3 w-3 mr-1" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="h-3 w-3 mr-1" /> Copy command
                        </>
                      )}
                    </Button>
                  </div>
                  <p className="text-xs">
                    Or enable{" "}
                    <span className="font-semibold">Force encode</span> below to
                    encode anyway — the metadata will report 19× FPS, but the
                    video will have visible artifacts.
                  </p>
                </AlertDescription>
              </Alert>
            )}

            {originalMeta && !originalMeta.allKeyframes && !keyframeError && (options.mode === "frame_inflation" || options.mode === "flame_inflation") && (
              <Alert className="mt-4 border-amber-500/50 bg-amber-500/5 text-amber-900 dark:text-amber-100">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <AlertDescription className="text-xs">
                  This video has P/B-frames. Inflation mode will refuse
                  to produce a corrupted output — either pre-process to all-I-frame
                  first, enable <span className="font-semibold">Auto-convert</span>{" "}
                  below, or switch to <span className="font-semibold">Header Patch</span>{" "}
                  mode (which works with any input).
                </AlertDescription>
              </Alert>
            )}

            {originalMeta && !originalMeta.allKeyframes && options.mode === "header_patch" && (
              <Alert className="mt-4 border-emerald-500/50 bg-emerald-500/5 text-emerald-900 dark:text-emerald-100">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                <AlertDescription className="text-xs">
                  This video has P/B-frames, but <span className="font-semibold">Header Patch</span>{" "}
                  mode doesn't touch sample tables — it only patches the mvhd
                  timescale. The video will encode without corruption.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Options + Action */}
        <div className="grid gap-6 md:grid-cols-3">
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5" />
                Encoder options
              </CardTitle>
              <CardDescription>
                Haze encoding parameters. Defaults match the haze_encode.sh
                reference script.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Mode selector */}
              <div className="space-y-2">
                <Label className="text-base">Encoding mode</Label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setOptions((o) => ({ ...o, mode: "header_patch" }))
                    }
                    className={`text-left rounded-lg border p-3 transition-colors ${
                      options.mode === "header_patch"
                        ? "border-emerald-500 bg-emerald-500/5"
                        : "border-border hover:border-muted-foreground/50"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      <span className="font-medium text-sm">
                        Header Patch
                      </span>
                      <Badge variant="secondary" className="ml-auto text-xs">
                        Recommended
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Metadata exploit. Patches mvhd timescale to trick TikTok
                      into passthrough. No corruption, works with any input.
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setOptions((o) => ({ ...o, mode: "frame_inflation" }))
                    }
                    className={`text-left rounded-lg border p-3 transition-colors ${
                      options.mode === "frame_inflation"
                        ? "border-amber-500 bg-amber-500/5"
                        : "border-border hover:border-muted-foreground/50"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      <span className="font-medium text-sm">
                        Frame Inflation
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Original method. Duplicates sample tables to show 19× FPS
                      in ffprobe. Requires all-I-frame input (auto-preprocess
                      available).
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setOptions((o) => ({ ...o, mode: "flame_inflation" }))
                    }
                    className={`text-left rounded-lg border p-3 transition-colors ${
                      options.mode === "flame_inflation"
                        ? "border-amber-500 bg-amber-500/5"
                        : "border-border hover:border-muted-foreground/50"
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Zap className="h-4 w-4 text-amber-500" />
                      <span className="font-medium text-sm">
                        Flame Inflation
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Alternative method. Multiplies samples per chunk in stsc
                      without duplicating chunk offsets. Requires all-I-frame.
                    </p>
                  </button>
                </div>
              </div>

              <Separator />

              {/* Multiplier */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="multiplier" className="text-base">
                    {options.mode === "header_patch"
                      ? "Timescale multiplier"
                      : "Frame multiplier (flame inflation)"}
                  </Label>
                  <Badge variant="secondary" className="font-mono text-base">
                    ×{options.multiplier}
                  </Badge>
                </div>
                <Slider
                  id="multiplier"
                  min={2}
                  max={30}
                  step={1}
                  value={[options.multiplier]}
                  onValueChange={(v) =>
                    setOptions((o) => ({ ...o, multiplier: v[0] }))
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {options.mode === "header_patch" ? (
                    <>
                      Multiplies <code className="font-mono">mvhd.timescale</code>{" "}
                      by this factor, creating a duration mismatch that tricks
                      TikTok's ingest parser into passthrough mode.
                    </>
                  ) : (
                    <>
                      Multiplies the internal frame rate by inflating{" "}
                      <code className="font-mono">stts</code> sample counts and{" "}
                      <code className="font-mono">mdhd</code> timescale. File info
                      will show{" "}
                      <span className="font-mono">
                        display_fps × multiplier
                      </span>
                      .
                    </>
                  )}
                </p>
              </div>

              <Separator />

              {/* Encoder tag */}
              <div className="space-y-2">
                <Label htmlFor="encoderTag" className="text-base">
                  Encoder tag
                </Label>
                <Input
                  id="encoderTag"
                  value={options.encoderTag}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, encoderTag: e.target.value }))
                  }
                  placeholder="Haze Encoder - example.com"
                />
                <p className="text-xs text-muted-foreground">
                  Written to <code className="font-mono">©too</code> atom in{" "}
                  <code className="font-mono">trak/udta/ilst</code>.
                </p>
              </div>

              <Separator />

              {/* Handler name */}
              <div className="space-y-2">
                <Label htmlFor="handlerName" className="text-base">
                  Handler name
                </Label>
                <Input
                  id="handlerName"
                  value={options.handlerName}
                  onChange={(e) =>
                    setOptions((o) => ({ ...o, handlerName: e.target.value }))
                  }
                  placeholder="VideoHandler"
                />
                <p className="text-xs text-muted-foreground">
                  Written to the <code className="font-mono">hdlr</code> box
                  name field.
                </p>
              </div>

              <Separator />

              {/* Toggles */}
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor="tiktok916" className="text-base">
                      Force TikTok 9:16 display
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      Overwrites <code className="font-mono">tkhd</code> width/height to{" "}
                      {options.tikTokWidth}×{options.tikTokHeight}.
                    </p>
                  </div>
                  <Switch
                    id="tiktok916"
                    checked={options.forceTikTok9x16}
                    onCheckedChange={(v) =>
                      setOptions((o) => ({ ...o, forceTikTok9x16: v }))
                    }
                  />
                </div>
                {(options.mode === "frame_inflation" || options.mode === "flame_inflation") && (
                  <div className="flex items-center justify-between rounded-lg border p-3">
                    <div className="space-y-0.5">
                      <Label htmlFor="dropSync" className="text-base">
                        Drop sync sample table
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Removes <code className="font-mono">stss</code> so every
                        frame is treated as a keyframe. Safer for haze-encoded
                        files.
                      </p>
                    </div>
                    <Switch
                      id="dropSync"
                      checked={options.dropSyncSamples}
                      onCheckedChange={(v) =>
                        setOptions((o) => ({ ...o, dropSyncSamples: v }))
                      }
                    />
                  </div>
                )}
                {(options.mode === "frame_inflation" || options.mode === "flame_inflation") && (
                  <div
                    className={`flex items-center justify-between rounded-lg border p-3 ${
                      options.autoPreprocess
                        ? "border-emerald-500/50 bg-emerald-500/5"
                        : ""
                    }`}
                  >
                    <div className="space-y-0.5">
                      <Label htmlFor="autoPreprocess" className="text-base flex items-center gap-1.5">
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        Auto-convert to all-I-frame (recommended)
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Uses ffmpeg.wasm to convert P/B-frame inputs to all-I-frame
                        before haze encoding. First run downloads ~30MB. Produces
                        artifact-free output for any input.
                      </p>
                    </div>
                    <Switch
                      id="autoPreprocess"
                      checked={options.autoPreprocess}
                      onCheckedChange={(v) => {
                        setOptions((o) => ({ ...o, autoPreprocess: v }));
                        setKeyframeError(null);
                      }}
                    />
                  </div>
                )}
                {(options.mode === "frame_inflation" || options.mode === "flame_inflation") && (
                  <div
                    className={`flex items-center justify-between rounded-lg border p-3 ${
                      options.forceEncode
                        ? "border-amber-500/50 bg-amber-500/5"
                        : "opacity-60"
                    } ${options.autoPreprocess ? "pointer-events-none" : ""}`}
                  >
                    <div className="space-y-0.5">
                      <Label htmlFor="forceEncode" className="text-base flex items-center gap-1.5">
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      Force encode (P/B-frame input)
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {options.autoPreprocess
                        ? "Disabled — auto-convert is on, which produces clean output."
                        : "Encode even when the input has P/B-frames. The metadata will report 19× FPS, but the video will have visible artifacts from compounding P-frame deltas."}
                    </p>
                  </div>
                  <Switch
                    id="forceEncode"
                    checked={options.forceEncode}
                    disabled={options.autoPreprocess}
                    onCheckedChange={(v) => {
                      setOptions((o) => ({ ...o, forceEncode: v }));
                      setKeyframeError(null);
                    }}
                  />
                </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Action card */}
          <Card className="md:col-span-1 flex flex-col">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Play className="h-5 w-5" />
                Encode
              </CardTitle>
              <CardDescription>Metadata only, no re-encoding.</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col gap-4">
              <div className="rounded-lg bg-muted/50 p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Status</span>
                  <span className="font-mono">
                    {isProcessing
                      ? "Encoding…"
                      : isReading
                        ? "Reading…"
                        : outputBlob
                          ? "Done"
                          : "Idle"}
                  </span>
                </div>
                {elapsedMs !== null && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Elapsed</span>
                    <span className="font-mono">
                      {(elapsedMs / 1000).toFixed(2)}s
                    </span>
                  </div>
                )}
                {originalMeta && (
                  <>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Input</span>
                      <span className="font-mono">
                        {formatBytes(originalMeta.fileSize)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Codec</span>
                      <span className="font-mono">
                        {originalMeta.codec || "mp4v"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Keyframes</span>
                      <span
                        className={`font-mono ${
                          originalMeta.allKeyframes
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-amber-600 dark:text-amber-400"
                        }`}
                      >
                        {originalMeta.keyframeCount}/{originalMeta.sampleCount}
                        {originalMeta.allKeyframes ? " ✓" : " ⚠"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">moov position</span>
                      <span className="font-mono">
                        {originalMeta.moovAtEnd ? "end (no faststart)" : "start (faststart)"}
                      </span>
                    </div>
                  </>
                )}
                {preprocessInfo && (
                  <>
                    <div className="border-t pt-2 mt-2">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-400 mb-1.5">
                        <CheckCircle2 className="h-3 w-3" />
                        Auto-preprocessed to all-I-frame
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Before</span>
                        <span className="font-mono">
                          {formatBytes(preprocessInfo.originalSize)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">After</span>
                        <span className="font-mono">
                          {formatBytes(preprocessInfo.preprocessedSize)}
                        </span>
                      </div>
                      {preprocessInfo.preprocessedMeta && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Keyframes</span>
                          <span className="font-mono text-emerald-600 dark:text-emerald-400">
                            {preprocessInfo.preprocessedMeta.keyframeCount}/
                            {preprocessInfo.preprocessedMeta.sampleCount} ✓
                          </span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Preproc time</span>
                        <span className="font-mono">
                          {(preprocessInfo.elapsedMs / 1000).toFixed(2)}s
                        </span>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {isProcessing && (
                <div className="space-y-2">
                  <Progress value={progress.percent} />
                  <p className="text-xs text-muted-foreground text-center">
                    {progress.stage} · {progress.percent}%
                  </p>
                </div>
              )}

              <Button
                size="lg"
                onClick={handleEncode}
                disabled={!file || !originalMeta || isProcessing || isReading}
                className="w-full bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 text-white"
              >
                {isProcessing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Encoding…
                  </>
                ) : (
                  <>
                    <Zap className="h-4 w-4 mr-2" />
                    Haze encode
                  </>
                )}
              </Button>

              {outputBlob && (
                <Button
                  size="lg"
                  variant="outline"
                  onClick={handleDownload}
                  className="w-full"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Download haze-encoded MP4
                </Button>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Before/After metadata */}
        {originalMeta && encodedMeta && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                Metadata comparison
              </CardTitle>
              <CardDescription>
                Before vs after haze encoding. The file is{" "}
                <span className="font-semibold text-foreground">not</span> re-encoded
                — only metadata boxes are rewritten.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="compare">
                <TabsList>
                  <TabsTrigger value="compare">Compare</TabsTrigger>
                  <TabsTrigger value="before">Before</TabsTrigger>
                  <TabsTrigger value="after">After</TabsTrigger>
                </TabsList>
                <TabsContent value="compare" className="mt-4">
                  <MetadataCompare
                    before={originalMeta}
                    after={encodedMeta}
                    multiplier={fpsMultiplier}
                  />
                </TabsContent>
                <TabsContent value="before" className="mt-4">
                  <MetadataTable meta={originalMeta} />
                </TabsContent>
                <TabsContent value="after" className="mt-4">
                  <MetadataTable meta={encodedMeta} />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}

        {/* Info card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Info className="h-5 w-5" />
              How it works
            </CardTitle>
          </CardHeader>
          <CardContent className="prose prose-sm dark:prose-invert max-w-none text-muted-foreground space-y-3">
            <p>
              The original <code className="font-mono">haze_encode.sh</code>{" "}
              script uses ffmpeg to re-encode the video with the{" "}
              <code className="font-mono">fps=INTERNAL_FPS:round=up</code> filter,
              which duplicates frames to reach the target internal FPS. This is
              slow because it actually decodes and re-encodes every frame.
            </p>
            <p>
              <span className="font-semibold text-foreground">
                This tool achieves the same metadata effect without any
                re-encoding.
              </span>{" "}
              It parses the MP4 box tree, then rewrites the relevant metadata
              boxes:
            </p>
            <ul className="list-disc pl-6 space-y-1.5">
              <li>
                <code className="font-mono">mdhd.timescale</code> is multiplied
                by 19, and <code className="font-mono">mdhd.duration</code> too
                — so real-time playback duration is unchanged.
              </li>
              <li>
                <code className="font-mono">stts.sample_count</code> is
                multiplied by 19, declaring 19× more frames.
              </li>
              <li>
                <code className="font-mono">stsz</code> repeats each sample
                size 19×, and <code className="font-mono">stco</code> repeats
                each chunk offset 19×. The decoder reads the same byte range 19
                times per original frame, producing 19 duplicate frames.
              </li>
              <li>
                Net effect:{" "}
                <code className="font-mono">
                  r_frame_rate = new_timescale / delta = 19 × original_fps
                </code>
                , shown as <span className="font-mono">19×</span> in file info.
              </li>
              <li>
                <code className="font-mono">moov</code> is moved to{" "}
                <span className="font-semibold">after</span>{" "}
                <code className="font-mono">mdat</code> (faststart OFF).
              </li>
              <li>
                A <code className="font-mono">©too</code> encoder tag is added
                under <code className="font-mono">trak/udta/ilst</code>.
              </li>
              <li>
                The <code className="font-mono">tkhd</code> width/height is
                overwritten to 1080×1920 (TikTok 9:16).
              </li>
            </ul>
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 my-3">
              <p className="text-sm font-semibold text-emerald-900 dark:text-emerald-100 mb-1 flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4" />
                Auto-preprocess to all-I-frame (default ON)
              </p>
              <p className="text-xs text-emerald-900 dark:text-emerald-100">
                Haze encoding duplicates samples by pointing multiple
                <code className="font-mono mx-1">stco</code>
                entries at the same byte offset. For I-frames this produces 19
                identical frames (correct). For P-frames, the same motion delta
                is applied 19× in a row, producing visible corruption.
              </p>
              <p className="text-xs text-emerald-900 dark:text-emerald-100 mt-2">
                <span className="font-semibold">When auto-preprocess is ON</span>{" "}
                (default), the app uses ffmpeg.wasm to convert any P/B-frame
                input to all-I-frame before haze encoding — produces
                artifact-free output for any input. First run downloads ~30MB
                (cached for subsequent runs).
              </p>
              <p className="text-xs text-emerald-900 dark:text-emerald-100 mt-2">
                <span className="font-semibold">When OFF</span>, you must
                pre-process manually with ffmpeg:
              </p>
              <code className="block font-mono text-xs mt-1 break-all text-emerald-900 dark:text-emerald-100">
                ffmpeg -i input.mp4 -g 1 -bf 0 -c:v libx264 -preset fast -crf 18 all_iframes.mp4
              </code>
            </div>
            <p className="text-xs">
              Note: TikTok does not publish its recompression/skip logic and
              changes it over time. Haze encoding reproduces the measurable
              differences between sample files; it is not a guaranteed bypass.
            </p>
          </CardContent>
        </Card>
      </main>

      <footer className="border-t border-border mt-auto">
        <div className="container mx-auto max-w-6xl px-4 py-6 text-sm text-muted-foreground flex flex-col md:flex-row items-center justify-between gap-2">
          <p>
            Haze Encoder · metadata-only MP4 haze encoding · runs 100% in your
            browser
          </p>
          <p className="font-mono text-xs">vercel-deployable · next.js 16</p>
        </div>
      </footer>
    </div>
  );
}

/** Side-by-side metadata comparison. */
function MetadataCompare({
  before,
  after,
  multiplier,
}: {
  before: VideoMetadata;
  after: VideoMetadata;
  multiplier: number;
}) {
  const rows: { label: string; before: string; after: string; highlight?: boolean }[] = [
    {
      label: "Resolution (tkhd)",
      before: `${before.width}×${before.height}`,
      after: `${after.width}×${after.height}`,
      highlight: before.width !== after.width || before.height !== after.height,
    },
    {
      label: "r_frame_rate",
      before: `${before.fps.toFixed(3)} fps`,
      after: `${after.fps.toFixed(3)} fps`,
      highlight: true,
    },
    {
      label: "avg_frame_rate",
      before: `${before.avgFps.toFixed(3)} fps`,
      after: `${after.avgFps.toFixed(3)} fps`,
      highlight: true,
    },
    {
      label: "Frame multiplier",
      before: "×1",
      after: multiplier > 0 ? `×${multiplier.toFixed(1)}` : "—",
      highlight: true,
    },
    {
      label: "Sample count (stts)",
      before: before.sampleCount.toLocaleString(),
      after: after.sampleCount.toLocaleString(),
      highlight: true,
    },
    {
      label: "Keyframes (stss)",
      before: `${before.keyframeCount.toLocaleString()}${before.allKeyframes ? " (all I-frames)" : ""}`,
      after: `${after.keyframeCount.toLocaleString()}${after.allKeyframes ? " (all I-frames)" : ""}`,
    },
    {
      label: "Codec",
      before: before.codec || "—",
      after: after.codec || "—",
    },
    {
      label: "Media timescale (mdhd)",
      before: before.timescale.toLocaleString(),
      after: after.timescale.toLocaleString(),
      highlight: true,
    },
    {
      label: "Duration",
      before: formatDuration(before.duration),
      after: formatDuration(after.duration),
    },
    {
      label: "Encoder tag",
      before: before.encoderTag ?? "—",
      after: after.encoderTag ?? "—",
      highlight: true,
    },
    {
      label: "Handler name",
      before: before.handlerName ?? "—",
      after: after.handlerName ?? "—",
    },
    {
      label: "moov position",
      before: before.moovAtEnd ? "end (no faststart)" : "start (faststart)",
      after: after.moovAtEnd ? "end (no faststart)" : "start (faststart)",
      highlight: true,
    },
    {
      label: "File size",
      before: formatBytes(before.fileSize),
      after: formatBytes(after.fileSize),
    },
  ];

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left px-4 py-2 font-medium">Field</th>
            <th className="text-left px-4 py-2 font-medium">Before</th>
            <th className="text-left px-4 py-2 font-medium">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b last:border-0">
              <td className="px-4 py-2 text-muted-foreground">{r.label}</td>
              <td className="px-4 py-2 font-mono">{r.before}</td>
              <td
                className={`px-4 py-2 font-mono ${
                  r.highlight
                    ? "text-orange-600 dark:text-orange-400 font-semibold"
                    : ""
                }`}
              >
                {r.highlight && <CheckCircle2 className="inline h-3 w-3 mr-1 text-emerald-500" />}
                {r.after}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Detailed single-side metadata table. */
function MetadataTable({ meta }: { meta: VideoMetadata }) {
  const rows: { label: string; value: string; icon?: React.ReactNode }[] = [
    {
      label: "Resolution",
      value: `${meta.width}×${meta.height}`,
      icon: <Monitor className="h-4 w-4" />,
    },
    {
      label: "r_frame_rate",
      value: `${meta.fps.toFixed(3)} fps`,
      icon: <Gauge className="h-4 w-4" />,
    },
    {
      label: "avg_frame_rate",
      value: `${meta.avgFps.toFixed(3)} fps`,
      icon: <Gauge className="h-4 w-4" />,
    },
    {
      label: "Duration",
      value: formatDuration(meta.duration),
      icon: <Clock className="h-4 w-4" />,
    },
    {
      label: "Timescale",
      value: meta.timescale.toLocaleString(),
      icon: <Film className="h-4 w-4" />,
    },
    {
      label: "Sample count",
      value: meta.sampleCount.toLocaleString(),
      icon: <Film className="h-4 w-4" />,
    },
    {
      label: "Encoder tag",
      value: meta.encoderTag ?? "—",
    },
    {
      label: "Handler name",
      value: meta.handlerName ?? "—",
    },
    {
      label: "moov position",
      value: meta.moovAtEnd ? "end (no faststart)" : "start (faststart)",
    },
    {
      label: "mdat offset",
      value: meta.mdatOffset >= 0 ? meta.mdatOffset.toLocaleString() : "—",
    },
    {
      label: "moov offset",
      value: meta.moovOffset.toLocaleString(),
    },
    {
      label: "File size",
      value: formatBytes(meta.fileSize),
    },
  ];

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.label}
              className={i % 2 === 0 ? "bg-muted/30" : ""}
            >
              <td className="px-4 py-2 text-muted-foreground flex items-center gap-2">
                {r.icon}
                {r.label}
              </td>
              <td className="px-4 py-2 font-mono">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
