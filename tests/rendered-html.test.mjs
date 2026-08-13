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

test("server-renders the complete code comparison workbench", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]*lang="zh-CN"/i);
  assert.match(html, /<title>逐字镜｜精确代码对比工具<\/title>/i);
  assert.match(html, /代码差在哪，<em>一眼看清。<\/em>/);
  assert.match(html, /aria-label="原始版本代码"/);
  assert.match(html, /aria-label="新版本代码"/);
  assert.match(html, /<label[^>]*for="left-code"[^>]*>\s*原始版本\s*<\/label>/);
  assert.match(html, /<label[^>]*for="right-code"[^>]*>\s*新版本\s*<\/label>/);
  assert.match(html, /仅看差异/);
  assert.match(html, /显示空白符/);
  assert.match(html, /复制差异/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /本地处理 · 代码不会上传/);
  assert.match(html, /class="token token-removed">userId<\/span>/);
  assert.match(html, /class="token token-added">id<\/span>/);
});

test("publishes product-specific social metadata", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /property="og:title" content="逐字镜｜精确代码对比工具"/);
  assert.match(
    html,
    /property="og:image" content="http:\/\/localhost(?::3000)?\/og\.png"/,
  );
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  await access(new URL("../public/og.png", import.meta.url));
});

test("removes the disposable starter and keeps exact text diff safeguards", async () => {
  const [page, layout, styles, packageJson, lockfile] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /function sequenceDiff/);
  assert.match(page, /function inlineTokens/);
  assert.match(page, /function alignChangedLines/);
  assert.match(page, /replace\(\/ \/g, "·"\)/);
  assert.match(page, /replace\(\/\\t\/g, "→ {3}"\)/);
  assert.match(page, /token-\$\{token\.kind\}/);
  assert.match(styles, /\.token-removed/);
  assert.match(styles, /\.token-added/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.doesNotMatch(layout, /Starter Project|codex-preview/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.doesNotMatch(lockfile, /react-loading-skeleton/);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await assert.rejects(access(new URL("../public/favicon.svg", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
  await access(templateRoot);
});
