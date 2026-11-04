import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Shell from "@/components/layout/Shell";
import AppProviders from "@/components/player/AppProviders";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Sonic — Free Music Streaming",
  description:
    "A keyless, personal music streaming app. For personal testing/education only.",
  // Favicon doubles as the touch icon until a proper apple-touch-icon PNG
  // (180x180) is added to app/.
  icons: { apple: "/favicon.ico" },
};

/**
 * Viewport: `viewportFit: cover` lets the UI paint edge-to-edge under iPhone
 * notches (env(safe-area-inset-*)); a dark themeColor matches --bg so the
 * browser chrome never flashes light around the app.
 */
export const viewport: Viewport = {
  viewportFit: "cover",
  themeColor: "#0b0b10",
};

/**
 * Root layout (server component).
 *
 * The player lives here so playback survives route changes: AppProviders is the
 * client boundary that supplies the global PlayerContext (a single shared
 * <audio> element) and renders the persistent mini-player bar. The server
 * Shell stays a server component; the provider/client tree hangs off it as a
 * child, so only the minimal player subtree is hydrated on the client.
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-bg text-text">
        <Shell>
          <AppProviders>{children}</AppProviders>
        </Shell>
      </body>
    </html>
  );
}
