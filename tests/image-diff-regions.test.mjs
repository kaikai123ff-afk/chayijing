import assert from "node:assert/strict";
import test from "node:test";

import { findDifferenceRegions } from "../app/image-diff-regions.ts";

function weights(width, height, points) {
  const values = new Uint32Array(width * height);
  for (const [x, y, weight = 1] of points) values[y * width + x] = weight;
  return values;
}

function filledEvidence(width, height, strengthAt) {
  const contentWeights = new Uint32Array(width * height);
  const contentStrengths = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      contentWeights[index] = 1;
      contentStrengths[index] = strengthAt(x, y);
    }
  }
  return { contentWeights, contentStrengths };
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
  assert.equal(result.outsideSummary, null);
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

test("keeps size-only evidence out of numbered content navigation", () => {
  const width = 80;
  const height = 80;
  const result = findDifferenceRegions({
    width,
    height,
    contentWeights: weights(width, height, [[40, 40, 3]]),
    outsideWeights: weights(width, height, [[40, 40, 5]]),
  });

  assert.equal(result.totalRegions, 1);
  assert.equal(result.hiddenRegions, 0);
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0].kind, "content");
  assert.equal(result.regions[0].pixelCount, 3);
  assert.equal(result.outsideSummary?.kind, "outside");
  assert.equal(result.outsideSummary?.pixelCount, 5);
  assert.equal(result.outsideSummary?.areaCount, 1);
  assert.equal(result.outsideSummary?.areas.length, 1);
  assert.equal(result.outsideSummary?.areas[0].kind, "outside");
});

test("represents an L-shaped size overhang as one summary with exact bands", () => {
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

  assert.equal(result.totalRegions, 0);
  assert.equal(result.hiddenRegions, 0);
  assert.deepEqual(result.regions, []);
  assert.equal(result.outsideSummary?.pixelCount, 3_600);
  assert.equal(result.outsideSummary?.areaCount, 2);
  const areas = result.outsideSummary?.areas ?? [];
  assert.equal(
    areas.some((area) => area.width === 1 && area.height === 1),
    false,
  );
  assert.ok(areas.some((area) => area.height > 0.75 && area.width < 0.3));
  assert.ok(areas.some((area) => area.width > 0.7 && area.height < 0.3));
  assert.ok(areas.every((area) => area.id.startsWith("outside-area-")));
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
  assert.equal(result.outsideSummary, null);
});

test("size-only areas do not consume the content-region limit", () => {
  const width = 120;
  const height = 80;
  const result = findDifferenceRegions({
    width,
    height,
    contentWeights: weights(width, height, [
      [10, 10, 1],
      [60, 35, 8],
      [105, 65, 3],
    ]),
    outsideWeights: weights(width, height, [
      [0, 0, 11],
      [119, 79, 13],
    ]),
    maxRegions: 2,
  });

  assert.equal(result.regions.length, 2);
  assert.ok(result.regions.every((region) => region.kind === "content"));
  assert.equal(result.totalRegions, 3);
  assert.equal(result.hiddenRegions, 1);
  assert.equal(result.outsideSummary?.pixelCount, 24);
  assert.equal(result.outsideSummary?.areaCount, 2);
});

test("suppresses widespread low-amplitude recompression noise", () => {
  const width = 96;
  const height = 72;
  const evidence = filledEvidence(
    width,
    height,
    (x, y) => 2 + ((x * 17 + y * 29) % 8),
  );
  const result = findDifferenceRegions({
    width,
    height,
    ...evidence,
    outsideWeights: new Uint32Array(width * height),
  });

  assert.equal(result.totalRegions, 0);
  assert.deepEqual(result.regions, []);
});

test("keeps an obvious structure on top of low-amplitude noise", () => {
  const width = 100;
  const height = 80;
  const evidence = filledEvidence(width, height, (x, y) =>
    x >= 42 && x < 55 && y >= 27 && y < 39 ? 120 : 5,
  );
  const result = findDifferenceRegions({
    width,
    height,
    ...evidence,
    outsideWeights: new Uint32Array(width * height),
  });

  assert.equal(result.totalRegions, 1);
  assert.equal(result.regions[0].kind, "content");
  assert.ok(result.regions[0].x > 0.3);
  assert.ok(result.regions[0].x + result.regions[0].width < 0.7);
  assert.ok(result.regions[0].y > 0.2);
  assert.ok(result.regions[0].y + result.regions[0].height < 0.65);
});

test("keeps a single high-contrast pixel but ignores isolated antialias noise", () => {
  const width = 120;
  const height = 80;
  const contentWeights = new Uint32Array(width * height);
  const contentStrengths = new Uint8Array(width * height);
  for (let y = 4; y < height; y += 10) {
    for (let x = 4; x < width; x += 10) {
      const index = y * width + x;
      contentWeights[index] = 1;
      contentStrengths[index] = 30;
    }
  }
  const obviousIndex = 63 * width + 103;
  contentWeights[obviousIndex] = 1;
  contentStrengths[obviousIndex] = 220;

  const result = findDifferenceRegions({
    width,
    height,
    contentWeights,
    contentStrengths,
    outsideWeights: new Uint32Array(width * height),
  });

  assert.equal(result.totalRegions, 1);
  const region = result.regions[0];
  assert.ok(region.x <= 103 / width);
  assert.ok(region.x + region.width > 103 / width);
  assert.ok(region.y <= 63 / height);
  assert.ok(region.y + region.height > 63 / height);
});

test("keeps a coherent visible color-area change", () => {
  const width = 100;
  const height = 100;
  const contentWeights = new Uint32Array(width * height);
  const contentStrengths = new Uint8Array(width * height);
  for (let y = 25; y < 60; y += 1) {
    for (let x = 30; x < 70; x += 1) {
      const index = y * width + x;
      contentWeights[index] = 1;
      contentStrengths[index] = 22;
    }
  }

  const result = findDifferenceRegions({
    width,
    height,
    contentWeights,
    contentStrengths,
    outsideWeights: new Uint32Array(width * height),
  });

  assert.equal(result.totalRegions, 1);
  assert.equal(result.regions[0].kind, "content");
  assert.ok(result.regions[0].pixelCount >= 1_300);
});
