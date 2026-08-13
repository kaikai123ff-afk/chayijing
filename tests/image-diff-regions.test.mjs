import assert from "node:assert/strict";
import test from "node:test";

import { findDifferenceRegions } from "../app/image-diff-regions.ts";

function weights(width, height, points) {
  const values = new Uint32Array(width * height);
  for (const [x, y, weight = 1] of points) values[y * width + x] = weight;
  return values;
}

test("keeps a single changed pixel as a visible difference region", () => {
  const width = 100;
  const height = 100;
  const result = findDifferenceRegions({
    width,
    height,
    contentWeights: weights(width, height, [[50, 50]]),
    outsideWeights: weights(width, height, []),
  });

  assert.equal(result.totalRegions, 1);
  assert.equal(result.regions[0].kind, "content");
  assert.equal(result.regions[0].pixelCount, 1);
  assert.ok(result.regions[0].width > 0);
  assert.ok(result.regions[0].height > 0);
});

test("groups nearby changed pixels and separates distant ones", () => {
  const width = 120;
  const height = 80;
  const result = findDifferenceRegions({
    width,
    height,
    contentWeights: weights(width, height, [
      [10, 10],
      [11, 11],
      [100, 60],
    ]),
    outsideWeights: weights(width, height, []),
  });

  assert.equal(result.totalRegions, 2);
  assert.deepEqual(result.regions.map((region) => region.pixelCount), [2, 1]);
  assert.ok(result.regions[0].centerY < result.regions[1].centerY);
});

test("never merges content differences with size-only regions", () => {
  const width = 80;
  const height = 80;
  const result = findDifferenceRegions({
    width,
    height,
    contentWeights: weights(width, height, [[40, 40, 3]]),
    outsideWeights: weights(width, height, [[40, 40, 5]]),
  });

  assert.equal(result.totalRegions, 2);
  assert.deepEqual(
    new Set(result.regions.map((region) => region.kind)),
    new Set(["content", "outside"]),
  );
});

test("keeps a right and bottom size overhang as separate bands", () => {
  const width = 100;
  const height = 100;
  const outsidePoints = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 80; x < width; x += 1) outsidePoints.push([x, y]);
  }
  for (let y = 80; y < height; y += 1) {
    for (let x = 0; x < 80; x += 1) outsidePoints.push([x, y]);
  }
  const result = findDifferenceRegions({
    width,
    height,
    contentWeights: weights(width, height, []),
    outsideWeights: weights(width, height, outsidePoints),
  });

  assert.equal(result.totalRegions, 2);
  assert.equal(result.regions.some((region) => region.width === 1 && region.height === 1), false);
  assert.ok(result.regions.some((region) => region.height > 0.75 && region.width < 0.3));
  assert.ok(result.regions.some((region) => region.width > 0.7 && region.height < 0.3));
});

test("caps rendered callouts without losing the total region count", () => {
  const width = 200;
  const height = 200;
  const points = [];
  for (let y = 4; y < 196; y += 8) {
    for (let x = 4; x < 196; x += 8) points.push([x, y]);
  }
  const result = findDifferenceRegions({
    width,
    height,
    contentWeights: weights(width, height, points),
    outsideWeights: weights(width, height, []),
    maxRegions: 20,
  });

  assert.equal(result.regions.length, 20);
  assert.ok(result.totalRegions > result.regions.length);
  assert.equal(result.hiddenRegions, result.totalRegions - 20);
});
