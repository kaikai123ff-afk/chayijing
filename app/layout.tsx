import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const PRODUCTION_URL = "https://zhuzijing-code-diff.linzirongxxyy.chatgpt.site";
const SITE_NAME = "差异镜";
const TITLE = "代码对比工具｜图片对比、图片找不同 - 差异镜";
const DESCRIPTION =
  "差异镜是免费的在线代码对比与图片对比工具：支持逐行、逐词、标点和空格差异高亮，也可将两张图片并排、滑动或局部放大找不同。代码与图片均在浏览器本地处理，不上传服务器。";
const SOCIAL_IMAGE = `${PRODUCTION_URL}/og.png`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(PRODUCTION_URL),
  title: TITLE,
  description: DESCRIPTION,
  alternates: {
    canonical: `${PRODUCTION_URL}/`,
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
    title: TITLE,
    description: DESCRIPTION,
    type: "website",
    url: `${PRODUCTION_URL}/`,
    siteName: SITE_NAME,
    locale: "zh_CN",
    images: [
      {
        url: SOCIAL_IMAGE,
        width: 1200,
        height: 630,
        alt: "差异镜在线代码对比与图片对比工具",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [SOCIAL_IMAGE],
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${PRODUCTION_URL}/#website`,
      url: `${PRODUCTION_URL}/`,
      name: SITE_NAME,
      alternateName: ["代码对比逐字镜", "在线代码与图片对比工具"],
      inLanguage: "zh-CN",
    },
    {
      "@type": "WebApplication",
      "@id": `${PRODUCTION_URL}/#application`,
      url: `${PRODUCTION_URL}/`,
      name: SITE_NAME,
      image: SOCIAL_IMAGE,
      applicationCategory: "UtilitiesApplication",
      operatingSystem: "Any",
      inLanguage: "zh-CN",
      isAccessibleForFree: true,
      description: DESCRIPTION,
      featureList: [
        "逐行、逐词、标点和空格代码差异高亮",
        "图片并排、滑杆、差异高亮与局部放大",
        "浏览器本地处理，免登录使用",
      ],
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "CNY",
      },
    },
  ],
};

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
            __html: JSON.stringify(structuredData).replace(/</g, "\\u003c"),
          }}
        />
      </body>
    </html>
  );
}
