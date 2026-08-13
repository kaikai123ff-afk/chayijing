"use client";

import {
  useDeferredValue,
  useMemo,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

type EditKind = "equal" | "delete" | "insert";
type RowKind = "equal" | "modified" | "deleted" | "added";
type ViewMode = "split" | "unified";

type SequenceEdit<T> = {
  kind: EditKind;
  value: T;
  leftIndex: number | null;
  rightIndex: number | null;
};

type LineEdit = SequenceEdit<string>;

type TokenPiece = {
  kind: "equal" | "removed" | "added";
  text: string;
};

type DiffRow = {
  id: string;
  kind: RowKind;
  leftLine: number | null;
  rightLine: number | null;
  leftTokens: TokenPiece[];
  rightTokens: TokenPiece[];
};

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

const MAX_LCS_CELLS = 6_000_000;

function splitLines(value: string) {
  if (!value) return [];
  return value.replace(/\r\n?/g, "\n").split("\n");
}

function tokenize(line: string) {
  return (
    line.match(/\s+|[\p{L}\p{M}\p{N}_$]+|./gu) ?? []
  );
}

function greedySequenceDiff<T>(left: T[], right: T[]): SequenceEdit<T>[] {
  const edits: SequenceEdit<T>[] = [];
  const lookAhead = 80;
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (Object.is(left[leftIndex], right[rightIndex])) {
      edits.push({
        kind: "equal",
        value: left[leftIndex],
        leftIndex,
        rightIndex,
      });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    let nextRightMatch = -1;
    for (
      let cursor = rightIndex + 1;
      cursor < Math.min(right.length, rightIndex + lookAhead);
      cursor += 1
    ) {
      if (Object.is(left[leftIndex], right[cursor])) {
        nextRightMatch = cursor;
        break;
      }
    }

    let nextLeftMatch = -1;
    for (
      let cursor = leftIndex + 1;
      cursor < Math.min(left.length, leftIndex + lookAhead);
      cursor += 1
    ) {
      if (Object.is(left[cursor], right[rightIndex])) {
        nextLeftMatch = cursor;
        break;
      }
    }

    const rightDistance =
      nextRightMatch < 0 ? Number.POSITIVE_INFINITY : nextRightMatch - rightIndex;
    const leftDistance =
      nextLeftMatch < 0 ? Number.POSITIVE_INFINITY : nextLeftMatch - leftIndex;

    if (rightDistance < leftDistance) {
      edits.push({
        kind: "insert",
        value: right[rightIndex],
        leftIndex: null,
        rightIndex,
      });
      rightIndex += 1;
    } else {
      edits.push({
        kind: "delete",
        value: left[leftIndex],
        leftIndex,
        rightIndex: null,
      });
      leftIndex += 1;
    }
  }

  while (leftIndex < left.length) {
    edits.push({
      kind: "delete",
      value: left[leftIndex],
      leftIndex,
      rightIndex: null,
    });
    leftIndex += 1;
  }

  while (rightIndex < right.length) {
    edits.push({
      kind: "insert",
      value: right[rightIndex],
      leftIndex: null,
      rightIndex,
    });
    rightIndex += 1;
  }

  return edits;
}

function sequenceDiff<T>(left: T[], right: T[]): SequenceEdit<T>[] {
  const rowLength = right.length + 1;
  const cellCount = (left.length + 1) * rowLength;

  if (cellCount > MAX_LCS_CELLS) {
    return greedySequenceDiff(left, right);
  }

  const table = new Uint32Array(cellCount);
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    const row = leftIndex * rowLength;
    const nextRow = (leftIndex + 1) * rowLength;
    for (
      let rightIndex = right.length - 1;
      rightIndex >= 0;
      rightIndex -= 1
    ) {
      table[row + rightIndex] = Object.is(left[leftIndex], right[rightIndex])
        ? table[nextRow + rightIndex + 1] + 1
        : Math.max(
            table[nextRow + rightIndex],
            table[row + rightIndex + 1],
          );
    }
  }

  const edits: SequenceEdit<T>[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (Object.is(left[leftIndex], right[rightIndex])) {
      edits.push({
        kind: "equal",
        value: left[leftIndex],
        leftIndex,
        rightIndex,
      });
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      table[(leftIndex + 1) * rowLength + rightIndex] >=
      table[leftIndex * rowLength + rightIndex + 1]
    ) {
      edits.push({
        kind: "delete",
        value: left[leftIndex],
        leftIndex,
        rightIndex: null,
      });
      leftIndex += 1;
    } else {
      edits.push({
        kind: "insert",
        value: right[rightIndex],
        leftIndex: null,
        rightIndex,
      });
      rightIndex += 1;
    }
  }

  while (leftIndex < left.length) {
    edits.push({
      kind: "delete",
      value: left[leftIndex],
      leftIndex,
      rightIndex: null,
    });
    leftIndex += 1;
  }

  while (rightIndex < right.length) {
    edits.push({
      kind: "insert",
      value: right[rightIndex],
      leftIndex: null,
      rightIndex,
    });
    rightIndex += 1;
  }

  return edits;
}

function tokenSimilarity(leftLine: string, rightLine: string) {
  const left = tokenize(leftLine).filter((token) => !/^\s+$/.test(token));
  const right = tokenize(rightLine).filter((token) => !/^\s+$/.test(token));

  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 1 : 0;
  }

  const edits = sequenceDiff(left, right);
  const matches = edits.filter((edit) => edit.kind === "equal").length;
  return matches / Math.max(left.length, right.length);
}

function alignChangedLines(deleted: LineEdit[], added: LineEdit[]) {
  if (deleted.length * added.length > 200_000) {
    const fallback: Array<{
      kind: "pair" | "delete" | "insert";
      deleted?: LineEdit;
      added?: LineEdit;
    }> = [];
    const length = Math.max(deleted.length, added.length);

    for (let index = 0; index < length; index += 1) {
      const deletedLine = deleted[index];
      const addedLine = added[index];
      if (deletedLine && addedLine) {
        fallback.push({ kind: "pair", deleted: deletedLine, added: addedLine });
      } else if (deletedLine) {
        fallback.push({ kind: "delete", deleted: deletedLine });
      } else if (addedLine) {
        fallback.push({ kind: "insert", added: addedLine });
      }
    }

    return fallback;
  }

  const width = added.length + 1;
  const costs = new Float32Array((deleted.length + 1) * width);

  for (let leftIndex = 1; leftIndex <= deleted.length; leftIndex += 1) {
    costs[leftIndex * width] = leftIndex;
  }
  for (let rightIndex = 1; rightIndex <= added.length; rightIndex += 1) {
    costs[rightIndex] = rightIndex;
  }

  for (let leftIndex = 1; leftIndex <= deleted.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= added.length; rightIndex += 1) {
      const similarity = tokenSimilarity(
        deleted[leftIndex - 1].value,
        added[rightIndex - 1].value,
      );
      const substitutionCost =
        similarity < 0.12 ? 2.05 : 0.55 + (1 - similarity) * 0.8;
      costs[leftIndex * width + rightIndex] = Math.min(
        costs[(leftIndex - 1) * width + rightIndex] + 1,
        costs[leftIndex * width + rightIndex - 1] + 1,
        costs[(leftIndex - 1) * width + rightIndex - 1] + substitutionCost,
      );
    }
  }

  const aligned: Array<{
    kind: "pair" | "delete" | "insert";
    deleted?: LineEdit;
    added?: LineEdit;
  }> = [];
  let leftIndex = deleted.length;
  let rightIndex = added.length;
  const closeTo = (a: number, b: number) => Math.abs(a - b) < 0.001;

  while (leftIndex > 0 || rightIndex > 0) {
    if (leftIndex > 0 && rightIndex > 0) {
      const similarity = tokenSimilarity(
        deleted[leftIndex - 1].value,
        added[rightIndex - 1].value,
      );
      const substitutionCost =
        similarity < 0.12 ? 2.05 : 0.55 + (1 - similarity) * 0.8;
      if (
        closeTo(
          costs[leftIndex * width + rightIndex],
          costs[(leftIndex - 1) * width + rightIndex - 1] + substitutionCost,
        )
      ) {
        aligned.push({
          kind: "pair",
          deleted: deleted[leftIndex - 1],
          added: added[rightIndex - 1],
        });
        leftIndex -= 1;
        rightIndex -= 1;
        continue;
      }
    }

    if (
      leftIndex > 0 &&
      (rightIndex === 0 ||
        closeTo(
          costs[leftIndex * width + rightIndex],
          costs[(leftIndex - 1) * width + rightIndex] + 1,
        ))
    ) {
      aligned.push({ kind: "delete", deleted: deleted[leftIndex - 1] });
      leftIndex -= 1;
    } else {
      aligned.push({ kind: "insert", added: added[rightIndex - 1] });
      rightIndex -= 1;
    }
  }

  return aligned.reverse();
}

function inlineTokens(leftLine: string, rightLine: string) {
  const edits = sequenceDiff(tokenize(leftLine), tokenize(rightLine));

  return {
    left: edits
      .filter((edit) => edit.kind !== "insert")
      .map<TokenPiece>((edit) => ({
        kind: edit.kind === "delete" ? "removed" : "equal",
        text: edit.value,
      })),
    right: edits
      .filter((edit) => edit.kind !== "delete")
      .map<TokenPiece>((edit) => ({
        kind: edit.kind === "insert" ? "added" : "equal",
        text: edit.value,
      })),
  };
}

function buildDiffRows(leftCode: string, rightCode: string): DiffRow[] {
  const edits = sequenceDiff(splitLines(leftCode), splitLines(rightCode));
  const rows: DiffRow[] = [];
  let editIndex = 0;
  let rowId = 0;

  while (editIndex < edits.length) {
    const edit = edits[editIndex];

    if (edit.kind === "equal") {
      rows.push({
        id: `row-${rowId}`,
        kind: "equal",
        leftLine: (edit.leftIndex ?? 0) + 1,
        rightLine: (edit.rightIndex ?? 0) + 1,
        leftTokens: [{ kind: "equal", text: edit.value }],
        rightTokens: [{ kind: "equal", text: edit.value }],
      });
      rowId += 1;
      editIndex += 1;
      continue;
    }

    const changedBlock: LineEdit[] = [];
    while (editIndex < edits.length && edits[editIndex].kind !== "equal") {
      changedBlock.push(edits[editIndex]);
      editIndex += 1;
    }

    const aligned = alignChangedLines(
      changedBlock.filter((item) => item.kind === "delete"),
      changedBlock.filter((item) => item.kind === "insert"),
    );

    for (const item of aligned) {
      if (item.kind === "pair" && item.deleted && item.added) {
        const tokens = inlineTokens(item.deleted.value, item.added.value);
        rows.push({
          id: `row-${rowId}`,
          kind: "modified",
          leftLine: (item.deleted.leftIndex ?? 0) + 1,
          rightLine: (item.added.rightIndex ?? 0) + 1,
          leftTokens: tokens.left,
          rightTokens: tokens.right,
        });
      } else if (item.kind === "delete" && item.deleted) {
        rows.push({
          id: `row-${rowId}`,
          kind: "deleted",
          leftLine: (item.deleted.leftIndex ?? 0) + 1,
          rightLine: null,
          leftTokens: [{ kind: "removed", text: item.deleted.value }],
          rightTokens: [],
        });
      } else if (item.added) {
        rows.push({
          id: `row-${rowId}`,
          kind: "added",
          leftLine: null,
          rightLine: (item.added.rightIndex ?? 0) + 1,
          leftTokens: [],
          rightTokens: [{ kind: "added", text: item.added.value }],
        });
      }
      rowId += 1;
    }
  }

  return rows;
}

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

function buildPatch(rows: DiffRow[], leftName: string, rightName: string) {
  const lines = [`--- ${leftName}`, `+++ ${rightName}`];
  for (const row of rows) {
    const left = row.leftTokens.map((token) => token.text).join("");
    const right = row.rightTokens.map((token) => token.text).join("");
    if (row.kind === "equal") lines.push(`  ${left}`);
    if (row.kind === "deleted") lines.push(`- ${left}`);
    if (row.kind === "added") lines.push(`+ ${right}`);
    if (row.kind === "modified") {
      lines.push(`- ${left}`);
      lines.push(`+ ${right}`);
    }
  }
  return lines.join("\n");
}

export default function Home() {
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
      await navigator.clipboard.writeText(buildPatch(rows, leftName, rightName));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="逐字镜首页">
          <span className="brand-mark" aria-hidden="true">
            Δ
          </span>
          <span>逐字镜</span>
          <span className="brand-version">DIFF</span>
        </a>
        <div className="header-status">
          <span className="status-dot" aria-hidden="true" />
          本地处理 · 代码不会上传
        </div>
      </header>

      <section className="hero" id="top">
        <div className="eyebrow">
          <span>PRECISION CODE DIFF</span>
          <span className="eyebrow-line" />
          <span>精确到词、标点与空格</span>
        </div>
        <h1>
          代码差在哪，<em>一眼看清。</em>
        </h1>
        <p>
          把两个版本放在一起，每一行变化都会对齐；哪怕只改了一个词，
          也会在行内单独标出。
        </p>
      </section>

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

      <footer>
        <div>
          <span className="footer-mark">Δ</span>
          <strong>逐字镜</strong>
        </div>
        <p>所有比较都在你的浏览器内完成。</p>
      </footer>
    </main>
  );
}
