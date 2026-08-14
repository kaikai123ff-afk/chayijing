"use client";

import {
  useDeferredValue,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  buildDiffRows,
  sequenceDiff,
  splitLines,
  type TokenPiece,
} from "./diff-engine";
import { ImageCompare } from "./ImageCompare";

type ViewMode = "split" | "unified";
type ComparisonType = "code" | "image";

const SAMPLE_LEFT = `async function fetchUser(userId: string) {
  const response = await fetch(\`/api/users/\${userId}\`);
  if (!response.ok) {
    throw new Error("Failed to load user");
  }
  return response.json();
}`;

const SAMPLE_RIGHT = `async function fetchUser(id: string) {
  const response = await fetch(\`/api/users/\${id}\`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Unable to load user");
  }
  return response.json();
}`;

function visibleWhitespace(value: string) {
  return value.replace(/ /g, "·").replace(/\t/g, "→   ");
}

function renderTokens(tokens: TokenPiece[], showWhitespace: boolean) {
  return tokens.map((token, index) => {
    const isWhitespace = /^\s+$/.test(token.text);
    return (
      <span
        className={`token token-${token.kind}${
          showWhitespace && isWhitespace ? " visible-whitespace" : ""
        }`}
        key={`${token.kind}-${index}`}
      >
        {showWhitespace && isWhitespace
          ? visibleWhitespace(token.text)
          : token.text}
      </span>
    );
  });
}

function lineCount(value: string) {
  return value ? splitLines(value).length : 0;
}

function buildPatch(
  leftCode: string,
  rightCode: string,
  leftName: string,
  rightName: string,
) {
  const lines = [`--- ${leftName}`, `+++ ${rightName}`];
  for (const edit of sequenceDiff(splitLines(leftCode), splitLines(rightCode))) {
    if (edit.kind === "equal") lines.push(`  ${edit.value}`);
    if (edit.kind === "delete") lines.push(`- ${edit.value}`);
    if (edit.kind === "insert") lines.push(`+ ${edit.value}`);
  }
  return lines.join("\n");
}

export default function Home() {
  const [comparisonType, setComparisonType] =
    useState<ComparisonType>("code");
  const [leftCode, setLeftCode] = useState(SAMPLE_LEFT);
  const [rightCode, setRightCode] = useState(SAMPLE_RIGHT);
  const [leftName, setLeftName] = useState("before.ts");
  const [rightName, setRightName] = useState("after.ts");
  const [viewMode, setViewMode] = useState<ViewMode>("split");
  const [onlyChanges, setOnlyChanges] = useState(false);
  const [showWhitespace, setShowWhitespace] = useState(false);
  const [copied, setCopied] = useState(false);
  const deferredLeft = useDeferredValue(leftCode);
  const deferredRight = useDeferredValue(rightCode);
  const rows = useMemo(
    () => buildDiffRows(deferredLeft, deferredRight),
    [deferredLeft, deferredRight],
  );
  const visibleRows = onlyChanges
    ? rows.filter((row) => row.kind !== "equal")
    : rows;
  const stats = useMemo(
    () => ({
      modified: rows.filter((row) => row.kind === "modified").length,
      added: rows.filter((row) => row.kind === "added").length,
      deleted: rows.filter((row) => row.kind === "deleted").length,
      equal: rows.filter((row) => row.kind === "equal").length,
    }),
    [rows],
  );
  const changeCount = stats.modified + stats.added + stats.deleted;

  const loadFile =
    (side: "left" | "right") => async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const content = await file.text();
      if (side === "left") {
        setLeftCode(content);
        setLeftName(file.name);
      } else {
        setRightCode(content);
        setRightName(file.name);
      }
      event.target.value = "";
    };

  const handleTab = (
    event: KeyboardEvent<HTMLTextAreaElement>,
    setValue: (value: string) => void,
  ) => {
    if (event.key !== "Tab") return;
    event.preventDefault();
    const editor = event.currentTarget;
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const nextValue = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`;
    setValue(nextValue);
    requestAnimationFrame(() => {
      editor.selectionStart = start + 2;
      editor.selectionEnd = start + 2;
    });
  };

  const swapSides = () => {
    setLeftCode(rightCode);
    setRightCode(leftCode);
    setLeftName(rightName);
    setRightName(leftName);
  };

  const resetSample = () => {
    setLeftCode(SAMPLE_LEFT);
    setRightCode(SAMPLE_RIGHT);
    setLeftName("before.ts");
    setRightName("after.ts");
  };

  const clearAll = () => {
    setLeftCode("");
    setRightCode("");
    setLeftName("原始代码");
    setRightName("新代码");
  };

  const copyPatch = async () => {
    try {
      await navigator.clipboard.writeText(
        buildPatch(leftCode, rightCode, leftName, rightName),
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="差异镜首页">
          <span className="brand-mark" aria-hidden="true">
            Δ
          </span>
          <span>差异镜</span>
          <span className="brand-version">DIFF</span>
        </a>
        <div className="header-status">
          <span className="status-dot" aria-hidden="true" />
          本地处理 · {comparisonType === "code" ? "代码" : "图片"}不会上传
        </div>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow">
          <span>
            CODE &amp; IMAGE DIFF
          </span>
          <span className="eyebrow-line" />
          <span>
            在线代码与图片对比工具
          </span>
        </div>
        <h1>
          在线代码对比与图片对比，<em>一眼找出每处差异。</em>
        </h1>
        <p>
          粘贴两个版本的代码，逐行、逐词查看修改；或选择两张图片，通过并排、滑杆、差异高亮和局部放大完成图片找不同。所有比较均在浏览器本地完成。
        </p>
      </section>

      <nav className="product-mode-switch" aria-label="对比类型">
        <button
          className={comparisonType === "code" ? "active" : ""}
          onClick={() => setComparisonType("code")}
          type="button"
          aria-pressed={comparisonType === "code"}
        >
          <span aria-hidden="true">&lt;/&gt;</span>
          代码对比
        </button>
        <button
          className={comparisonType === "image" ? "active" : ""}
          onClick={() => setComparisonType("image")}
          type="button"
          aria-pressed={comparisonType === "image"}
        >
          <span aria-hidden="true">▧</span>
          图片对比
        </button>
      </nav>

      <div className="mode-panel" hidden={comparisonType !== "code"}>
      <section className="workbench" aria-label="代码对比工作台">
        <div className="workbench-toolbar">
          <div className="live-badge">
            <span aria-hidden="true">◉</span>
            实时对比
          </div>
          <div className="toolbar-actions">
            <button className="text-button" onClick={resetSample} type="button">
              载入示例
            </button>
            <button className="text-button" onClick={swapSides} type="button">
              <span aria-hidden="true">⇄</span> 交换两侧
            </button>
            <button className="text-button danger" onClick={clearAll} type="button">
              清空
            </button>
          </div>
        </div>

        <div className="editor-grid">
          <article className="editor-card editor-before">
            <div className="editor-heading">
              <div>
                <label
                  className="side-label before-label"
                  htmlFor="left-code"
                >
                  原始版本
                </label>
                <strong>{leftName}</strong>
              </div>
              <div className="editor-meta">
                <span>{lineCount(leftCode)} 行</span>
                <label className="file-button" htmlFor="left-file">
                  导入文件
                </label>
                <input
                  id="left-file"
                  className="file-input"
                  type="file"
                  onChange={loadFile("left")}
                />
              </div>
            </div>
            <textarea
              id="left-code"
              aria-label="原始版本代码"
              value={leftCode}
              onChange={(event) => setLeftCode(event.target.value)}
              onKeyDown={(event) => handleTab(event, setLeftCode)}
              placeholder="在这里粘贴原始代码…"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </article>

          <article className="editor-card editor-after">
            <div className="editor-heading">
              <div>
                <label
                  className="side-label after-label"
                  htmlFor="right-code"
                >
                  新版本
                </label>
                <strong>{rightName}</strong>
              </div>
              <div className="editor-meta">
                <span>{lineCount(rightCode)} 行</span>
                <label className="file-button" htmlFor="right-file">
                  导入文件
                </label>
                <input
                  id="right-file"
                  className="file-input"
                  type="file"
                  onChange={loadFile("right")}
                />
              </div>
            </div>
            <textarea
              id="right-code"
              aria-label="新版本代码"
              value={rightCode}
              onChange={(event) => setRightCode(event.target.value)}
              onKeyDown={(event) => handleTab(event, setRightCode)}
              placeholder="在这里粘贴新代码…"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </article>
        </div>
      </section>

      <section className="results" aria-labelledby="results-title">
        <div className="results-topline">
          <div>
            <span className="section-index">02 / 对比结果</span>
            <h2 id="results-title">
              {changeCount === 0 ? "两个版本完全一致" : `发现 ${changeCount} 处行级变化`}
            </h2>
          </div>
          <div className={`match-status ${changeCount === 0 ? "identical" : "changed"}`}>
            <span aria-hidden="true">{changeCount === 0 ? "✓" : "!"}</span>
            {changeCount === 0 ? "没有差异" : "已精确标注"}
          </div>
        </div>

        <div className="summary-bar" aria-label="差异统计">
          <div className="stat stat-modified">
            <strong>{stats.modified}</strong>
            <span>修改</span>
          </div>
          <div className="stat stat-added">
            <strong>{stats.added}</strong>
            <span>新增</span>
          </div>
          <div className="stat stat-deleted">
            <strong>{stats.deleted}</strong>
            <span>删除</span>
          </div>
          <div className="stat stat-equal">
            <strong>{stats.equal}</strong>
            <span>未变</span>
          </div>
          <div className="summary-spacer" />
          <div className="legend" aria-label="颜色说明">
            <span><i className="legend-old" />删除内容</span>
            <span><i className="legend-new" />新增内容</span>
          </div>
        </div>

        <div className="result-toolbar">
          <div className="segmented" aria-label="结果视图">
            <button
              className={viewMode === "split" ? "active" : ""}
              onClick={() => setViewMode("split")}
              type="button"
              aria-pressed={viewMode === "split"}
            >
              双栏
            </button>
            <button
              className={viewMode === "unified" ? "active" : ""}
              onClick={() => setViewMode("unified")}
              type="button"
              aria-pressed={viewMode === "unified"}
            >
              单栏
            </button>
          </div>
          <div className="result-options">
            <label className="check-option">
              <input
                checked={onlyChanges}
                onChange={(event) => setOnlyChanges(event.target.checked)}
                type="checkbox"
              />
              <span>仅看差异</span>
            </label>
            <label className="check-option">
              <input
                checked={showWhitespace}
                onChange={(event) => setShowWhitespace(event.target.checked)}
                type="checkbox"
              />
              <span>显示空白符</span>
            </label>
            <button className="copy-button" onClick={copyPatch} type="button">
              {copied ? "已复制 ✓" : "复制差异"}
            </button>
          </div>
        </div>

        <div className={`diff-view ${viewMode}`} aria-live="polite">
          {rows.length === 0 ? (
            <div className="empty-state">
              <span aria-hidden="true">⌁</span>
              <strong>等待代码</strong>
              <p>在上方两侧粘贴代码，差异会立即显示在这里。</p>
            </div>
          ) : visibleRows.length === 0 ? (
            <div className="empty-state compact">
              <span aria-hidden="true">✓</span>
              <strong>没有可显示的差异</strong>
              <p>关闭“仅看差异”即可查看全部相同行。</p>
            </div>
          ) : viewMode === "split" ? (
            <>
              <div className="diff-column-head split-grid" aria-hidden="true">
                <span />
                <span>{leftName}</span>
                <span />
                <span>{rightName}</span>
              </div>
              <div className="diff-scroll">
                {visibleRows.map((row) => (
                  <div
                    className={`diff-row split-grid row-${row.kind}`}
                    key={row.id}
                    aria-label={
                      row.kind === "modified"
                        ? "修改行"
                        : row.kind === "added"
                          ? "新增行"
                          : row.kind === "deleted"
                            ? "删除行"
                            : "相同行"
                    }
                  >
                    <span className="line-number left-number">
                      {row.leftLine ?? ""}
                    </span>
                    <pre className="code-cell left-code">
                      <span className="change-sign" aria-hidden="true">
                        {row.kind === "modified" || row.kind === "deleted" ? "−" : " "}
                      </span>
                      <code>{renderTokens(row.leftTokens, showWhitespace)}</code>
                    </pre>
                    <span className="line-number right-number">
                      {row.rightLine ?? ""}
                    </span>
                    <pre className="code-cell right-code">
                      <span className="change-sign" aria-hidden="true">
                        {row.kind === "modified" || row.kind === "added" ? "+" : " "}
                      </span>
                      <code>{renderTokens(row.rightTokens, showWhitespace)}</code>
                    </pre>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="diff-scroll unified-scroll">
              {visibleRows.flatMap((row) => {
                if (row.kind === "equal") {
                  return (
                    <div className="unified-row row-equal" key={row.id}>
                      <span className="line-number">{row.leftLine}</span>
                      <span className="line-number">{row.rightLine}</span>
                      <span className="unified-sign" />
                      <pre className="code-cell"><code>{renderTokens(row.leftTokens, showWhitespace)}</code></pre>
                    </div>
                  );
                }

                const rendered = [];
                if (row.leftLine !== null) {
                  rendered.push(
                    <div className="unified-row row-deleted" key={`${row.id}-old`}>
                      <span className="line-number">{row.leftLine}</span>
                      <span className="line-number" />
                      <span className="unified-sign">−</span>
                      <pre className="code-cell"><code>{renderTokens(row.leftTokens, showWhitespace)}</code></pre>
                    </div>,
                  );
                }
                if (row.rightLine !== null) {
                  rendered.push(
                    <div className="unified-row row-added" key={`${row.id}-new`}>
                      <span className="line-number" />
                      <span className="line-number">{row.rightLine}</span>
                      <span className="unified-sign">+</span>
                      <pre className="code-cell"><code>{renderTokens(row.rightTokens, showWhitespace)}</code></pre>
                    </div>,
                  );
                }
                return rendered;
              })}
            </div>
          )}
        </div>
      </section>
      </div>
      <div className="mode-panel" hidden={comparisonType !== "image"}>
        <ImageCompare />
      </div>

      <section className="seo-overview" aria-labelledby="seo-overview-title">
        <div className="seo-overview-heading">
          <span className="section-index">03 / 功能说明</span>
          <h2 id="seo-overview-title">免费在线代码对比与图片差异对比</h2>
          <p>
            差异镜把在线代码对比和图片找不同放在同一个页面里，无需登录或安装软件，打开即可使用。
          </p>
        </div>

        <div className="seo-feature-grid">
          <article>
            <span className="seo-feature-icon" aria-hidden="true">&lt;/&gt;</span>
            <h3>代码对比：精确到单词、标点和空格</h3>
            <p>
              粘贴新旧两版代码，自动对齐新增、删除和修改行，并在行内标出不同的单词、字符、标点与空格。适合代码审查，以及 JSON、SQL、配置文件和脚本版本比较。
            </p>
          </article>
          <article>
            <span className="seo-feature-icon" aria-hidden="true">▧</span>
            <h3>图片对比：并排查看与图片找不同</h3>
            <p>
              选择两张图片，可用并排、滑杆和图片差异高亮查看变化；编号定位肉眼可见的内容差异，局部放大核对细节，并单独说明图片尺寸范围变化。
            </p>
          </article>
          <article>
            <span className="seo-feature-icon" aria-hidden="true">◎</span>
            <h3>免登录，本地处理敏感内容</h3>
            <p>
              代码与 PNG、JPG、WebP 图片只在当前浏览器中分析，不上传服务器。比较结果即时生成，关闭页面后不会在网站中保留你的内容。
            </p>
          </article>
        </div>

        <div className="seo-steps" aria-label="使用步骤">
          <strong>三步完成对比</strong>
          <ol>
            <li><span>1</span>选择代码对比或图片对比</li>
            <li><span>2</span>放入两个版本的内容</li>
            <li><span>3</span>查看高亮、编号与局部细节</li>
          </ol>
        </div>
      </section>

      <footer>
        <div>
          <span className="footer-mark">Δ</span>
          <strong>差异镜</strong>
        </div>
        <p>所有比较都在你的浏览器内完成。</p>
      </footer>
    </main>
  );
}
