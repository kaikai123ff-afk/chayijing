export type EditKind = "equal" | "delete" | "insert";
export type RowKind = "equal" | "modified" | "deleted" | "added";

export type SequenceEdit<T> = {
  kind: EditKind;
  value: T;
  leftIndex: number | null;
  rightIndex: number | null;
  jsonIdentity?: string;
};

export type LineEdit = SequenceEdit<string>;

export type TokenPiece = {
  kind: "equal" | "removed" | "added";
  text: string;
};

export type DiffRow = {
  id: string;
  kind: RowKind;
  leftLine: number | null;
  rightLine: number | null;
  leftTokens: TokenPiece[];
  rightTokens: TokenPiece[];
};

type AlignedChange = {
  kind: "pair" | "delete" | "insert";
  deleted?: LineEdit;
  added?: LineEdit;
};

type JsonProperty = {
  key: string;
  colonIndex: number;
};

const MAX_LCS_CELLS = 6_000_000;
const MAX_ALIGNMENT_CELLS = 200_000;

export function splitLines(value: string) {
  if (!value) return [];
  return value.replace(/\r\n?/g, "\n").split("\n");
}

export function tokenize(line: string) {
  return line.match(/\s+|[\p{L}\p{M}\p{N}_$]+|./gu) ?? [];
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

export function sequenceDiff<T>(left: T[], right: T[]): SequenceEdit<T>[] {
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

function extractJsonProperty(line: string): JsonProperty | null {
  const match = line.match(/^\s*"((?:\\.|[^"\\])*)"\s*:/u);
  if (!match) return null;

  try {
    return {
      key: JSON.parse(`"${match[1]}"`) as string,
      colonIndex: match[0].lastIndexOf(":"),
    };
  } catch {
    return null;
  }
}

function leadingIndent(line: string) {
  const prefix = line.match(/^[\t ]*/)?.[0] ?? "";
  return Array.from(prefix).reduce(
    (width, character) => width + (character === "\t" ? 2 : 1),
    0,
  );
}

function valueOpensContainer(line: string, colonIndex: number) {
  const value = line.slice(colonIndex + 1).trimStart();
  return value.startsWith("{") || value.startsWith("[");
}

function computeJsonFieldIdentities(lines: string[]) {
  const identities = new Map<number, string>();
  const stack: Array<{ indent: number; key: string | null }> = [];

  lines.forEach((line, lineIndex) => {
    const indent = leadingIndent(line);
    while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const property = extractJsonProperty(line);
    if (property) {
      const path = [
        ...stack.flatMap((item) => (item.key === null ? [] : [item.key])),
        property.key,
      ];
      identities.set(lineIndex, JSON.stringify(path));

      if (valueOpensContainer(line, property.colonIndex)) {
        stack.push({ indent, key: property.key });
      }
      return;
    }

    const trimmed = line.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      stack.push({ indent, key: null });
    }
  });

  return identities;
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

function substitutionCost(
  leftLine: string,
  rightLine: string,
  leftIdentity?: string,
  rightIdentity?: string,
) {
  if (leftIdentity || rightIdentity) {
    return leftIdentity && leftIdentity === rightIdentity ? 0.2 : 2.05;
  }

  const leftProperty = extractJsonProperty(leftLine);
  const rightProperty = extractJsonProperty(rightLine);

  if (leftProperty || rightProperty) return 2.05;

  const similarity = tokenSimilarity(leftLine, rightLine);
  return similarity < 0.28 ? 2.05 : 0.55 + (1 - similarity) * 0.8;
}

export function alignChangedLines(
  deleted: LineEdit[],
  added: LineEdit[],
): AlignedChange[] {
  if (deleted.length * added.length > MAX_ALIGNMENT_CELLS) {
    return [
      ...deleted.map<AlignedChange>((item) => ({ kind: "delete", deleted: item })),
      ...added.map<AlignedChange>((item) => ({ kind: "insert", added: item })),
    ];
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
      const pairCost = substitutionCost(
        deleted[leftIndex - 1].value,
        added[rightIndex - 1].value,
        deleted[leftIndex - 1].jsonIdentity,
        added[rightIndex - 1].jsonIdentity,
      );
      costs[leftIndex * width + rightIndex] = Math.min(
        costs[(leftIndex - 1) * width + rightIndex] + 1,
        costs[leftIndex * width + rightIndex - 1] + 1,
        costs[(leftIndex - 1) * width + rightIndex - 1] + pairCost,
      );
    }
  }

  const aligned: AlignedChange[] = [];
  let leftIndex = deleted.length;
  let rightIndex = added.length;
  const closeTo = (a: number, b: number) => Math.abs(a - b) < 0.001;

  while (leftIndex > 0 || rightIndex > 0) {
    if (leftIndex > 0 && rightIndex > 0) {
      const pairCost = substitutionCost(
        deleted[leftIndex - 1].value,
        added[rightIndex - 1].value,
        deleted[leftIndex - 1].jsonIdentity,
        added[rightIndex - 1].jsonIdentity,
      );
      if (
        pairCost < 2 &&
        closeTo(
          costs[leftIndex * width + rightIndex],
          costs[(leftIndex - 1) * width + rightIndex - 1] + pairCost,
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

function mergeTokenPieces(pieces: TokenPiece[]) {
  return pieces.reduce<TokenPiece[]>((merged, piece) => {
    const previous = merged[merged.length - 1];
    if (previous?.kind === piece.kind) {
      previous.text += piece.text;
    } else {
      merged.push({ ...piece });
    }
    return merged;
  }, []);
}

export function inlineTokens(leftLine: string, rightLine: string) {
  const edits = sequenceDiff(tokenize(leftLine), tokenize(rightLine));

  return {
    left: mergeTokenPieces(
      edits
        .filter((edit) => edit.kind !== "insert")
        .map<TokenPiece>((edit) => ({
          kind: edit.kind === "delete" ? "removed" : "equal",
          text: edit.value,
        })),
    ),
    right: mergeTokenPieces(
      edits
        .filter((edit) => edit.kind !== "delete")
        .map<TokenPiece>((edit) => ({
          kind: edit.kind === "insert" ? "added" : "equal",
          text: edit.value,
        })),
    ),
  };
}

function findForcedJsonPairs(
  edits: LineEdit[],
  leftLines: string[],
  rightLines: string[],
) {
  const leftIdentities = computeJsonFieldIdentities(leftLines);
  const rightIdentities = computeJsonFieldIdentities(rightLines);
  const deletedByIdentity = new Map<string, LineEdit[]>();
  const addedByIdentity = new Map<string, LineEdit[]>();

  for (const edit of edits) {
    const identity =
      edit.kind === "delete" && edit.leftIndex !== null
        ? leftIdentities.get(edit.leftIndex)
        : edit.kind === "insert" && edit.rightIndex !== null
          ? rightIdentities.get(edit.rightIndex)
          : undefined;
    if (!identity) continue;

    const target = edit.kind === "delete" ? deletedByIdentity : addedByIdentity;
    const bucket = target.get(identity);
    if (bucket) bucket.push(edit);
    else target.set(identity, [edit]);
  }

  const pairedByInsert = new Map<LineEdit, LineEdit>();
  const pairedDeletes = new Set<LineEdit>();

  for (const [identity, deleted] of deletedByIdentity) {
    const added = addedByIdentity.get(identity);
    if (
      deleted.length === 1 &&
      added?.length === 1
    ) {
      pairedByInsert.set(added[0], deleted[0]);
      pairedDeletes.add(deleted[0]);
    }
  }

  return { pairedByInsert, pairedDeletes };
}

function appendAlignedRows(
  rows: DiffRow[],
  aligned: AlignedChange[],
  nextId: () => string,
) {
  for (const item of aligned) {
    if (item.kind === "pair" && item.deleted && item.added) {
      const tokens = inlineTokens(item.deleted.value, item.added.value);
      rows.push({
        id: nextId(),
        kind: "modified",
        leftLine: (item.deleted.leftIndex ?? 0) + 1,
        rightLine: (item.added.rightIndex ?? 0) + 1,
        leftTokens: tokens.left,
        rightTokens: tokens.right,
      });
    } else if (item.kind === "delete" && item.deleted) {
      rows.push({
        id: nextId(),
        kind: "deleted",
        leftLine: (item.deleted.leftIndex ?? 0) + 1,
        rightLine: null,
        leftTokens: [{ kind: "removed", text: item.deleted.value }],
        rightTokens: [],
      });
    } else if (item.added) {
      rows.push({
        id: nextId(),
        kind: "added",
        leftLine: null,
        rightLine: (item.added.rightIndex ?? 0) + 1,
        leftTokens: [],
        rightTokens: [{ kind: "added", text: item.added.value }],
      });
    }
  }
}

export function buildDiffRows(leftCode: string, rightCode: string): DiffRow[] {
  const leftLines = splitLines(leftCode);
  const rightLines = splitLines(rightCode);
  let jsonMode = false;
  try {
    JSON.parse(leftCode);
    JSON.parse(rightCode);
    jsonMode = true;
  } catch {
    jsonMode = false;
  }
  const leftIdentities = jsonMode
    ? computeJsonFieldIdentities(leftLines)
    : new Map<number, string>();
  const rightIdentities = jsonMode
    ? computeJsonFieldIdentities(rightLines)
    : new Map<number, string>();
  const leftComparisonLines = leftLines.map((line, lineIndex) => {
    const identity = leftIdentities.get(lineIndex);
    return identity ? `json:${identity}\u0000${line}` : `text:${line}`;
  });
  const rightComparisonLines = rightLines.map((line, lineIndex) => {
    const identity = rightIdentities.get(lineIndex);
    return identity ? `json:${identity}\u0000${line}` : `text:${line}`;
  });
  const edits = sequenceDiff(leftComparisonLines, rightComparisonLines).map<LineEdit>(
    (edit) => ({
      ...edit,
      value:
        edit.kind === "insert"
          ? rightLines[edit.rightIndex ?? 0]
          : leftLines[edit.leftIndex ?? 0],
      jsonIdentity:
        edit.kind === "insert"
          ? rightIdentities.get(edit.rightIndex ?? 0)
          : leftIdentities.get(edit.leftIndex ?? 0),
    }),
  );
  const { pairedByInsert, pairedDeletes } = jsonMode
    ? findForcedJsonPairs(edits, leftLines, rightLines)
    : {
        pairedByInsert: new Map<LineEdit, LineEdit>(),
        pairedDeletes: new Set<LineEdit>(),
      };
  const rows: DiffRow[] = [];
  let editIndex = 0;
  let rowId = 0;
  const nextId = () => `row-${rowId++}`;

  while (editIndex < edits.length) {
    const edit = edits[editIndex];

    if (edit.kind === "equal") {
      rows.push({
        id: nextId(),
        kind: "equal",
        leftLine: (edit.leftIndex ?? 0) + 1,
        rightLine: (edit.rightIndex ?? 0) + 1,
        leftTokens: [{ kind: "equal", text: edit.value }],
        rightTokens: [{ kind: "equal", text: edit.value }],
      });
      editIndex += 1;
      continue;
    }

    if (pairedDeletes.has(edit)) {
      editIndex += 1;
      continue;
    }

    const forcedDeleted = pairedByInsert.get(edit);
    if (edit.kind === "insert" && forcedDeleted) {
      appendAlignedRows(
        rows,
        [{ kind: "pair", deleted: forcedDeleted, added: edit }],
        nextId,
      );
      editIndex += 1;
      continue;
    }

    const changedBlock: LineEdit[] = [];
    while (editIndex < edits.length && edits[editIndex].kind !== "equal") {
      const candidate = edits[editIndex];
      if (pairedDeletes.has(candidate) || pairedByInsert.has(candidate)) break;
      changedBlock.push(candidate);
      editIndex += 1;
    }

    if (changedBlock.length === 0) continue;
    appendAlignedRows(
      rows,
      alignChangedLines(
        changedBlock.filter((item) => item.kind === "delete"),
        changedBlock.filter((item) => item.kind === "insert"),
      ),
      nextId,
    );
  }

  return rows;
}
