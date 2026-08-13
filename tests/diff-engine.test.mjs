import assert from "node:assert/strict";
import test from "node:test";

import { buildDiffRows, inlineTokens } from "../app/diff-engine.ts";

function tokenText(tokens) {
  return tokens.map((token) => token.text).join("");
}

function rowText(row, side) {
  return tokenText(side === "left" ? row.leftTokens : row.rightTokens);
}

test("pairs a changed JSON field on the same split row", () => {
  const rows = buildDiffRows(
    `{
  "title": "old"
}`,
    `{
  "title": "new"
}`,
  );

  const titleRows = rows.filter(
    (row) => rowText(row, "left").includes('"title"') || rowText(row, "right").includes('"title"'),
  );
  assert.equal(titleRows.length, 1);
  assert.equal(titleRows[0].kind, "modified");
  assert.equal(rowText(titleRows[0], "left"), '  "title": "old"');
  assert.equal(rowText(titleRows[0], "right"), '  "title": "new"');
});

test("keeps the old and new value together even when the field moves across an unchanged anchor", () => {
  const rows = buildDiffRows(
    `{
  "title": "old",
  "stable": true,
  "count": 1
}`,
    `{
  "stable": true,
  "title": "new",
  "count": 1
}`,
  );

  const titleRows = rows.filter(
    (row) => rowText(row, "left").includes('"title"') || rowText(row, "right").includes('"title"'),
  );
  assert.equal(titleRows.length, 1);
  assert.equal(titleRows[0].kind, "modified");
  assert.equal(titleRows[0].leftLine, 2);
  assert.equal(titleRows[0].rightLine, 3);
  assert.match(rowText(titleRows[0], "left"), /"old"/);
  assert.match(rowText(titleRows[0], "right"), /"new"/);
});

test("does not mislabel unrelated JSON fields as a modification", () => {
  const rows = buildDiffRows(
    `{
  "keep": 0,
  "obsolete": 1
}`,
    `{
  "keep": 0,
  "created": false
}`,
  );

  const obsolete = rows.find((row) => rowText(row, "left").includes('"obsolete"'));
  const created = rows.find((row) => rowText(row, "right").includes('"created"'));
  assert.equal(obsolete?.kind, "deleted");
  assert.equal(created?.kind, "added");
  assert.notEqual(obsolete?.id, created?.id);
});

test("uses the full nested JSON path when repeated keys move", () => {
  const rows = buildDiffRows(
    `{
  "billing": {
    "enabled": false
  },
  "shipping": {
    "enabled": true
  }
}`,
    `{
  "shipping": {
    "enabled": false
  },
  "billing": {
    "enabled": true
  }
}`,
  );

  const enabledChanges = rows.filter(
    (row) => row.kind === "modified" && rowText(row, "left").includes('"enabled"'),
  );
  assert.equal(enabledChanges.length, 2);
  assert.deepEqual(
    enabledChanges.map((row) => [row.leftLine, row.rightLine]),
    [
      [6, 3],
      [3, 6],
    ],
  );
});

test("pairs an unchanged JSON field once when it only changes position", () => {
  const rows = buildDiffRows(
    `{
  "a": 1,
  "b": 2,
  "c": 3
}`,
    `{
  "b": 2,
  "a": 1,
  "c": 3
}`,
  );

  for (const key of ["a", "b"]) {
    const fieldRows = rows.filter(
      (row) => rowText(row, "left").includes(`"${key}"`) || rowText(row, "right").includes(`"${key}"`),
    );
    assert.equal(fieldRows.length, 1);
    assert.notEqual(fieldRows[0].leftLine, null);
    assert.notEqual(fieldRows[0].rightLine, null);
  }
});

test("does not pair the same nested key from different parent paths", () => {
  const rows = buildDiffRows(
    `{
  "a": {
    "x": 1
  }
}`,
    `{
  "b": {
    "x": 2
  }
}`,
  );

  assert.equal(
    rows.filter(
      (row) => row.kind === "modified" && rowText(row, "left").includes('"x"'),
    ).length,
    0,
  );
  assert.equal(
    rows.filter((row) => row.kind === "deleted" && rowText(row, "left").includes('"x"')).length,
    1,
  );
  assert.equal(
    rows.filter((row) => row.kind === "added" && rowText(row, "right").includes('"x"')).length,
    1,
  );
});

test("does not enable global JSON pairing for JavaScript object fragments", () => {
  const rows = buildDiffRows(
    `const a = {
  "x": 1
};
const b = {
  "x": 2
};`,
    `const b = {
  "x": 3
};
const a = {
  "x": 4
};`,
  );

  assert.ok(rows.length > 0);
  assert.equal(rows.some((row) => row.leftLine === 2 && row.rightLine === 5), false);
});

test("preserves exact text while highlighting word, punctuation, and whitespace changes", () => {
  const left = "const userId = value == 1;";
  const right = "const userID  = value === 1;";
  const tokens = inlineTokens(left, right);

  assert.equal(tokenText(tokens.left), left);
  assert.equal(tokenText(tokens.right), right);
  assert.ok(tokens.left.some((token) => token.kind === "removed"));
  assert.ok(tokens.right.some((token) => token.kind === "added"));
});
