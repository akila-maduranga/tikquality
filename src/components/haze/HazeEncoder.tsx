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
  Film,
  Clock,
  Gauge,
  Monitor,
} from "lucide-react";
import {
  DEFAULT_OPTIONS,
  HazeOptions,
  VideoMetadata,
  formatBytes,
  formatDuration,
  hazeEncode,
  parseMP4,
  readMetadata,
} from "@/lib/mp4";

interface ProgressState {
  stage: string;
  percent: number;
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
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setFile(file);
    setError(null);
    setOutputBlob(null);
    setOutputUrl(null);
    setEncodedMeta(null);
    setElapsedMs(null);
    setOriginalMeta(null);

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
    setProgress({ stage: "Starting...", percent: 0 });
    setOutputBlob(null);
    setOutputUrl(null);
    setEncodedMeta(null);

    try {
      const buffer = new Uint8Array(await file.arrayBuffer());
      const result = await hazeEncode(buffer, options, (stage, percent) => {
        setProgress({ stage, percent });
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
      setError(`Encoding failed: ${(e as Error).message}`);
    } finally {
      setIsProcessing(false);
    }
  }, [file, options]);

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
                        </>
                      )}
                    </p>
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
              {/* Multiplier */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="multiplier" className="text-base">
                    Frame multiplier (flame inflation)
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
                  Multiplies the internal frame rate by inflating{" "}
                  <code className="font-mono">stts</code> sample counts and{" "}
                  <code className="font-mono">mdhd</code> timescale. File info
                  will show <span className="font-mono">display_fps × multiplier</span>.
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
                      <span className="text-muted-foreground">moov position</span>
                      <span className="font-mono">
                        {originalMeta.moovAtEnd ? "end (no faststart)" : "start (faststart)"}
                      </span>
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
