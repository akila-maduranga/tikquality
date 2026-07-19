import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Haze Encoder — metadata-only MP4 haze encoding",
  description:
    "Browser-based haze encoder for MP4 videos. Inflates internal frame rate 19×, disables faststart, embeds custom encoder tag, forces TikTok 9:16 — all without re-encoding a single frame. Vercel-deployable.",
  keywords: [
    "haze encode",
    "MP4 metadata",
    "TikTok 9:16",
    "faststart off",
    "frame rate inflation",
    "FFmpeg alternative",
    "browser video processing",
  ],
  authors: [{ name: "Haze Encoder" }],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "Haze Encoder",
    description:
      "Metadata-only MP4 haze encoding. 19× FPS inflation, faststart off, TikTok 9:16. No re-encoding.",
    url: "https://haze.vercel.app",
    siteName: "Haze Encoder",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Haze Encoder",
    description:
      "Metadata-only MP4 haze encoding. 19× FPS inflation, faststart off, TikTok 9:16.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
