import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

async function fetchWorker(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("route", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the complete code comparison workbench", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="zh-CN"/i);
  assert.match(html, /<title>代码对比工具｜图片对比、图片找不同 - 差异镜<\/title>/i);
  assert.match(html, /在线代码对比与图片对比，<em>一眼找出每处差异。<\/em>/);
  assert.match(html, /aria-label="对比类型"/);
  assert.match(html, /代码对比/);
  assert.match(html, /图片对比/);
  assert.match(html, /aria-label="原始版本代码"/);
  assert.match(html, /aria-label="新版本代码"/);
  assert.match(html, /<label[^>]*for="left-code"[^>]*>\s*原始版本\s*<\/label>/);
  assert.match(html, /<label[^>]*for="right-code"[^>]*>\s*新版本\s*<\/label>/);
  assert.match(html, /仅看差异/);
  assert.match(html, /显示空白符/);
  assert.match(html, /复制差异/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /本地处理 · (?:<!-- -->)?代码(?:<!-- -->)?不会上传/);
  assert.match(html, /差异镜首页/);
  assert.match(html, /免费在线代码对比与图片差异对比/);
  assert.match(html, /代码对比：精确到单词、标点和空格/);
  assert.match(html, /图片对比：并排查看与图片找不同/);
  assert.match(html, /免登录，本地处理敏感内容/);
  assert.match(html, /"@type":"WebSite"/);
  assert.match(html, /"@type":"WebApplication"/);
  assert.match(html, /"name":"差异镜"/);
  assert.doesNotMatch(html, /name="keywords"/i);
  assert.match(html, /class="token token-removed">userId<\/span>/);
  assert.match(html, /class="token token-added">id<\/span>/);
});

test("publishes product-specific social metadata", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(
    html,
    /property="og:title" content="代码对比工具｜图片对比、图片找不同 - 差异镜"/,
  );
  assert.match(html, /name="robots" content="index, follow/);
  assert.match(
    html,
    /rel="canonical" href="https:\/\/zhuzijing-code-diff\.linzirongxxyy\.chatgpt\.site\/?"/,
  );
  assert.match(html, /property="og:site_name" content="差异镜"/);
  assert.match(
    html,
    /property="og:image" content="https:\/\/zhuzijing-code-diff\.linzirongxxyy\.chatgpt\.site\/og\.png"/,
  );
  assert.match(html, /差异镜是免费的在线代码对比与图片对比工具/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  await access(new URL("../public/og.png", import.meta.url));
  await access(new URL("../public/robots.txt", import.meta.url));
  await access(new URL("../public/sitemap.xml", import.meta.url));
  assert.equal(
    await readFile(new URL("../public/robots.txt", import.meta.url), "utf8"),
    "User-agent: *\nAllow: /\n\nSitemap: https://zhuzijing-code-diff.linzirongxxyy.chatgpt.site/sitemap.xml\n",
  );
  assert.match(
    await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8"),
    /<loc>https:\/\/zhuzijing-code-diff\.linzirongxxyy\.chatgpt\.site\/<\/loc>[\s\S]*<lastmod>2026-08-14<\/lastmod>/,
  );
  assert.equal(
    await readFile(
      new URL("../public/googlef52a125fcc3f3dd3.html", import.meta.url),
      "utf8",
    ),
    "google-site-verification: googlef52a125fcc3f3dd3.html\n",
  );
  assert.equal(
    await readFile(
      new URL("../public/googlecc06e13e9b63a95f.html", import.meta.url),
      "utf8",
    ),
    "google-site-verification: googlecc06e13e9b63a95f.html\n",
  );
});

test("serves the Google verification token without redirecting", async () => {
  for (const token of [
    "googlef52a125fcc3f3dd3",
    "googlecc06e13e9b63a95f",
  ]) {
    const response = await fetchWorker(`/${token}.html`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("location"), null);
    assert.equal(
      await response.text(),
      `google-site-verification: ${token}.html`,
    );
  }
});

test("removes the disposable starter and keeps local comparison safeguards", async () => {
  const [page, imageCompare, imageRegions, diffEngine, layout, styles, packageJson, lockfile] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/ImageCompare.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/image-diff-regions.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/diff-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  ]);

  assert.match(diffEngine, /function sequenceDiff/);
  assert.match(diffEngine, /function inlineTokens/);
  assert.match(diffEngine, /function alignChangedLines/);
  assert.match(diffEngine, /findForcedJsonPairs/);
  assert.match(page, /replace\(\/ \/g, "·"\)/);
  assert.match(page, /replace\(\/\\t\/g, "→ {3}"\)/);
  assert.match(page, /token-\$\{token\.kind\}/);
  assert.match(styles, /\.token-removed/);
  assert.match(styles, /\.token-added/);
  assert.match(styles, /\.image-slider-stage/);
  assert.match(styles, /\.difference-overlay/);
  assert.match(styles, /\.difference-region-box/);
  assert.match(styles, /\.difference-marker/);
  assert.match(styles, /\.difference-zoom/);
  assert.match(imageCompare, /image\/png,image\/jpeg,image\/webp/);
  assert.match(imageCompare, /analyzeImages/);
  assert.match(imageCompare, /差异高亮/);
  assert.match(imageCompare, /肉眼可见内容差异/);
  assert.match(imageCompare, /两栏用相同编号标出同一处变化/);
  assert.match(imageCompare, /interactive=\{false\}/);
  assert.match(imageCompare, /image-annotation-stage/);
  assert.match(imageCompare, /上一处图片差异/);
  assert.match(imageCompare, /下一处图片差异/);
  assert.match(imageCompare, /编号只对应画面内容变化/);
  assert.match(imageCompare, /不参与内容差异编号/);
  assert.match(imageCompare, /DifferenceZoomComparison/);
  assert.match(imageCompare, /原图与新图局部放大/);
  assert.match(imageCompare, /差异较多，当前只显示此编号/);
  assert.match(styles, /\.difference-region-box\.dense-muted/);
  assert.match(imageCompare, /stats\.previewWidth/);
  assert.match(imageCompare, /tabIndex=\{isActive \? 0 : -1\}/);
  assert.match(imageRegions, /findDifferenceRegions/);
  assert.match(imageRegions, /contentWeights/);
  assert.match(imageRegions, /outsideWeights/);
  assert.match(imageRegions, /outsideSummary/);
  assert.match(imageCompare, /图片只在当前浏览器中解码和分析，不会上传/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(imageCompare, /fetch\(|XMLHttpRequest|FormData/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(lockfile, /react-loading-skeleton/);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await assert.rejects(access(new URL("../public/favicon.svg", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(templateRoot);
});
