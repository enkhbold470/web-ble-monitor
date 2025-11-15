import { Toaster } from "@/components/ui/toaster";
import type { Metadata } from "next";


import { Viewport } from "next";
import { Open_Sans } from "next/font/google";
import { siteConfig  } from "@/config/site";
import "./globals.css";

const openSans = Open_Sans({ subsets: ["latin"] });

export const viewport: Viewport = {
  themeColor: "light",
  width: "device-width",
  initialScale: 1,
  minimumScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: siteConfig.name,
  description: siteConfig.description,
  // manifest: "/icons/site.webmanifest",
  generator: "Next.js",
  openGraph: {
    title: siteConfig.name,
    description: siteConfig.description,
    url: siteConfig.url,
    siteName: siteConfig.name,
    images: [siteConfig.ogImage],
  },
  keywords: siteConfig.keywords,
  icons: [
    { rel: "apple-touch-icon", url: "/icons/android-chrome-192x192.png" },
    { rel: "icon", url: "/icons/android-chrome-192x192.png" },
  ],

    applicationName: siteConfig.name,
  authors: [
    {
      name: "Inky Ganbold",
      url: "https://chat.enk.icu",
    },
  ],
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
      <html lang="en" suppressHydrationWarning>
        <body className={`${openSans.className} flex flex-col min-h-screen overflow-x-hidden`}>

          <main className="flex-grow">
            {children}
          </main>
          <Toaster />

        </body>
      </html>
  );
}
