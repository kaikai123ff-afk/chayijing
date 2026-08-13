import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "代码对比逐字镜｜精确代码对比工具";
  const description =
    "代码对比逐字镜：在线逐行、逐词比较两个代码版本，精确高亮新增、删除、修改、标点和空格差异。";
  const imageUrl = new URL("/og-renamed.png", origin).toString();
  const canonicalUrl = new URL("/", origin).toString();

  return {
    metadataBase: new URL(origin),
    title,
    description,
    alternates: {
      canonical: canonicalUrl,
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-image-preview": "large",
        "max-snippet": -1,
      },
    },
    openGraph: {
      title,
      description,
      type: "website",
      url: canonicalUrl,
      siteName: "代码对比逐字镜",
      locale: "zh_CN",
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 630,
          alt: "代码对比逐字镜在线工具",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        {children}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "WebApplication",
              name: "代码对比逐字镜",
              applicationCategory: "DeveloperApplication",
              operatingSystem: "Any",
              description:
                "在线逐行、逐词比较两个代码版本，精确高亮新增、删除、修改、标点和空格差异。",
              offers: {
                "@type": "Offer",
                price: "0",
                priceCurrency: "CNY",
              },
            }).replace(/</g, "\\u003c"),
          }}
        />
      </body>
    </html>
  );
}
