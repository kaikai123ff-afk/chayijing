export type DifferenceRegionKind = "content" | "outside";

export type DifferenceRegion = {
  id: string;
  kind: DifferenceRegionKind;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  pixelCount: number;
};

export type DifferenceRegionResult = {
  /** Numbered, navigable visual-content changes only. */
  regions: DifferenceRegion[];
  /** Total visual-content changes before applying maxRegions. */
  totalRegions: number;
  /** Visual-content changes that remain highlighted but are not numbered. */
  hiddenRegions: number;
  /** Size-only evidence is one semantic summary and never enters navigation. */
  outsideSummary: OutsideDifferenceSummary | null;
};

export type OutsideDifferenceSummary = {
  kind: "outside";
  pixelCount: number;
  areaCount: number;
  /** Exact, unnumbered bands used to draw non-misleading size-only geometry. */
  areas: DifferenceRegion[];
};

type RegionInput = {
  width: number;
  height: number;
  /** Number of source-image pixels represented by each preview pixel. */
  contentWeights: Uint32Array;
  /** Number of size-only source pixels represented by each preview pixel. */
  outsideWeights: Uint32Array;
  /** Maximum channel delta (0-255) represented by each content preview pixel. */
  contentStrengths?: Uint8Array;
  maxRegions?: number;
};

type RawRegion = Omit<DifferenceRegion, "id"> & { score: number };

type OutsideRun = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  pixelCount: number;
};

const DEFAULT_MAX_REGIONS = 48;
const SINGLE_PIXEL_STRENGTH = 64;
const MODERATE_STRENGTH = 28;
const DENSE_VISIBLE_MEAN = 18;
const MIN_RESIDUAL_MEAN = 6;

function makeRegion(
  kind: DifferenceRegionKind,
  left: number,
  top: number,
  right: number,
  bottom: number,
  pixelCount: number,
  score: number,
  canvasWidth: number,
  canvasHeight: number,
  padding: number,
): RawRegion {
  const paddedLeft = Math.max(0, left - padding);
  const paddedTop = Math.max(0, top - padding);
  const paddedRight = Math.min(canvasWidth, right + padding);
  const paddedBottom = Math.min(canvasHeight, bottom + padding);
  const regionWidth = Math.max(1, paddedRight - paddedLeft);
  const regionHeight = Math.max(1, paddedBottom - paddedTop);

  return {
    kind,
    x: paddedLeft / canvasWidth,
    y: paddedTop / canvasHeight,
    width: regionWidth / canvasWidth,
    height: regionHeight / canvasHeight,
    centerX: (paddedLeft + regionWidth / 2) / canvasWidth,
    centerY: (paddedTop + regionHeight / 2) / canvasHeight,
    pixelCount,
    score,
  };
}

function percentileFromHistogram(
  histogram: Uint32Array,
  observations: number,
  percentile: number,
) {
  if (observations === 0) return 0;
  const target = Math.max(1, Math.ceil(observations * percentile));
  let seen = 0;
  for (let value = 1; value < histogram.length; value += 1) {
    seen += histogram[value];
    if (seen >= target) return value;
  }
  return histogram.length - 1;
}

function contentRegions(
  width: number,
  height: number,
  weights: Uint32Array,
  strengths: Uint8Array | undefined,
) {
  const tileSize = Math.max(2, Math.round(Math.min(width, height) / 160));
  const tileColumns = Math.ceil(width / tileSize);
  const tileRows = Math.ceil(height / tileSize);
  const tileCount = tileColumns * tileRows;
  const activeCounts = new Uint32Array(tileCount);
  const sourcePixelCounts = new Uint32Array(tileCount);
  const strengthSums = new Uint32Array(tileCount);
  const maxStrengths = new Uint8Array(tileCount);
  const minXs = new Int32Array(tileCount);
  const minYs = new Int32Array(tileCount);
  const maxXs = new Int32Array(tileCount);
  const maxYs = new Int32Array(tileCount);
  minXs.fill(width);
  minYs.fill(height);
  maxXs.fill(-1);
  maxYs.fill(-1);

  const histogram = new Uint32Array(256);
  let totalActive = 0;
  let totalStrength = 0;
  let totalStrengthSquared = 0;
  let allMinX = width;
  let allMinY = height;
  let allMaxX = -1;
  let allMaxY = -1;
  let allSourcePixels = 0;

  for (let y = 0; y < height; y += 1) {
    const tileY = Math.floor(y / tileSize);
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const sourcePixels = weights[pixelIndex];
      if (sourcePixels === 0) continue;

      // Callers predating contentStrengths supplied binary weights. Treat those
      // as intentional changes so one-pixel diffs remain discoverable.
      const strength = strengths ? strengths[pixelIndex] : 255;
      if (strength === 0) continue;

      const tileIndex = tileY * tileColumns + Math.floor(x / tileSize);
      activeCounts[tileIndex] += 1;
      sourcePixelCounts[tileIndex] += sourcePixels;
      strengthSums[tileIndex] += strength;
      maxStrengths[tileIndex] = Math.max(maxStrengths[tileIndex], strength);
      minXs[tileIndex] = Math.min(minXs[tileIndex], x);
      minYs[tileIndex] = Math.min(minYs[tileIndex], y);
      maxXs[tileIndex] = Math.max(maxXs[tileIndex], x);
      maxYs[tileIndex] = Math.max(maxYs[tileIndex], y);

      histogram[strength] += 1;
      totalActive += 1;
      totalStrength += strength;
      totalStrengthSquared += strength * strength;
      allMinX = Math.min(allMinX, x);
      allMinY = Math.min(allMinY, y);
      allMaxX = Math.max(allMaxX, x);
      allMaxY = Math.max(allMaxY, y);
      allSourcePixels += sourcePixels;
    }
  }

  if (totalActive === 0) return [];

  const coverage = totalActive / (width * height);
  // A widespread low-amplitude floor is characteristic of recompression. It
  // should not make every tile a signal, but strong departures from it should.
  const noiseFloor =
    coverage >= 0.18
      ? Math.min(24, percentileFromHistogram(histogram, totalActive, 0.5))
      : 0;
  const signalTiles = new Uint8Array(tileCount);

  for (let tileY = 0; tileY < tileRows; tileY += 1) {
    for (let tileX = 0; tileX < tileColumns; tileX += 1) {
      const tileIndex = tileY * tileColumns + tileX;
      const active = activeCounts[tileIndex];
      if (active === 0) continue;

      const actualWidth = Math.min(tileSize, width - tileX * tileSize);
      const actualHeight = Math.min(tileSize, height - tileY * tileSize);
      const tileArea = actualWidth * actualHeight;
      const strengthSum = strengthSums[tileIndex];
      const rawMeanOverTile = strengthSum / tileArea;
      const residualMeanOverTile = Math.max(
        0,
        (strengthSum - active * noiseFloor) / tileArea,
      );
      const oneDimensional = width === 1 || height === 1;
      const requiredModerate = oneDimensional
        ? Math.min(tileArea, Math.max(2, Math.ceil(tileArea * 0.08)))
        : Math.max(2, Math.ceil(tileArea * 0.08));
      const requiredDense = oneDimensional
        ? Math.min(tileArea, Math.max(4, Math.ceil(tileArea * 0.22)))
        : Math.max(4, Math.ceil(tileArea * 0.22));
      const moderateCutoff = Math.max(
        MODERATE_STRENGTH,
        noiseFloor + 14,
      );
      let moderate = 0;

      // Tiles are small (at most about 9x9 in the current preview), so this
      // local scan avoids allocating another full-size strength-class array.
      const startX = tileX * tileSize;
      const startY = tileY * tileSize;
      for (let y = startY; y < startY + actualHeight; y += 1) {
        for (let x = startX; x < startX + actualWidth; x += 1) {
          const pixelIndex = y * width + x;
          if (weights[pixelIndex] === 0) continue;
          const strength = strengths ? strengths[pixelIndex] : 255;
          if (strength >= moderateCutoff) moderate += 1;
        }
      }

      const isVisible =
        maxStrengths[tileIndex] >= SINGLE_PIXEL_STRENGTH ||
        moderate >= requiredModerate ||
        (active >= requiredDense && rawMeanOverTile >= DENSE_VISIBLE_MEAN) ||
        (active >= requiredDense && residualMeanOverTile >= MIN_RESIDUAL_MEAN);
      if (isVisible) signalTiles[tileIndex] = 1;
    }
  }

  const regions: RawRegion[] = [];
  const visited = new Uint8Array(tileCount);
  const queue = new Int32Array(tileCount);

  for (let start = 0; start < tileCount; start += 1) {
    if (visited[start] || signalTiles[start] === 0) continue;

    let queueStart = 0;
    let queueEnd = 0;
    queue[queueEnd++] = start;
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let regionSourcePixels = 0;
    let regionStrength = 0;
    let regionPeak = 0;

    while (queueStart < queueEnd) {
      const tileIndex = queue[queueStart++];
      const tileX = tileIndex % tileColumns;
      const tileY = Math.floor(tileIndex / tileColumns);
      minX = Math.min(minX, minXs[tileIndex]);
      minY = Math.min(minY, minYs[tileIndex]);
      maxX = Math.max(maxX, maxXs[tileIndex]);
      maxY = Math.max(maxY, maxYs[tileIndex]);
      regionSourcePixels += sourcePixelCounts[tileIndex];
      regionStrength += strengthSums[tileIndex];
      regionPeak = Math.max(regionPeak, maxStrengths[tileIndex]);

      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = tileX + offsetX;
          const nextY = tileY + offsetY;
          if (
            nextX < 0 ||
            nextY < 0 ||
            nextX >= tileColumns ||
            nextY >= tileRows
          ) {
            continue;
          }
          const next = nextY * tileColumns + nextX;
          if (!visited[next] && signalTiles[next] !== 0) {
            visited[next] = 1;
            queue[queueEnd++] = next;
          }
        }
      }
    }

    regions.push(
      makeRegion(
        "content",
        minX,
        minY,
        maxX + 1,
        maxY + 1,
        regionSourcePixels,
        regionStrength + regionPeak * 4 + Math.sqrt(regionSourcePixels) * 32,
        width,
        height,
        tileSize,
      ),
    );
  }

  // A coherent, subtle whole-area color change can have no isolated strong
  // tile. Keep it when its magnitude is stable enough to be visibly distinct.
  if (regions.length === 0 && coverage >= 0.15) {
    const mean = totalStrength / totalActive;
    const variance = Math.max(
      0,
      totalStrengthSquared / totalActive - mean * mean,
    );
    const deviation = Math.sqrt(variance);
    if (mean >= 14 && deviation <= Math.max(3, mean * 0.15)) {
      regions.push(
        makeRegion(
          "content",
          allMinX,
          allMinY,
          allMaxX + 1,
          allMaxY + 1,
          allSourcePixels,
          totalStrength + mean * 4,
          width,
          height,
          tileSize,
        ),
      );
    }
  }

  return regions;
}

function outsideRegions(
  width: number,
  height: number,
  weights: Uint32Array,
) {
  const regions: RawRegion[] = [];
  let active = new Map<string, OutsideRun>();

  const finish = (run: OutsideRun) => {
    regions.push(
      makeRegion(
        "outside",
        run.left,
        run.top,
        run.right,
        run.bottom,
        run.pixelCount,
        run.pixelCount * 255,
        width,
        height,
        1,
      ),
    );
  };

  for (let y = 0; y < height; y += 1) {
    const current = new Map<string, OutsideRun>();
    let x = 0;
    while (x < width) {
      while (x < width && weights[y * width + x] === 0) x += 1;
      if (x >= width) break;
      const left = x;
      let pixelCount = 0;
      while (x < width && weights[y * width + x] > 0) {
        pixelCount += weights[y * width + x];
        x += 1;
      }
      const right = x;
      const key = `${left}:${right}`;
      const previous = active.get(key);
      current.set(
        key,
        previous
          ? {
              ...previous,
              bottom: y + 1,
              pixelCount: previous.pixelCount + pixelCount,
            }
          : { left, right, top: y, bottom: y + 1, pixelCount },
      );
    }

    for (const [key, run] of active) {
      if (!current.has(key)) finish(run);
    }
    active = current;
  }

  for (const run of active.values()) finish(run);
  return regions;
}

function selectRegions(rawRegions: RawRegion[], requestedLimit: number) {
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(0, Math.floor(requestedLimit))
    : DEFAULT_MAX_REGIONS;
  const byScore = [...rawRegions].sort(
    (left, right) =>
      right.score - left.score ||
      left.centerY - right.centerY ||
      left.centerX - right.centerX ||
      left.kind.localeCompare(right.kind),
  );
  if (limit === 0) return [];
  if (byScore.length <= limit) return byScore;

  return byScore.slice(0, limit);
}

/**
 * Groups preview-pixel evidence into readable callout boxes. Low-amplitude,
 * high-frequency content changes are treated as a recompression noise floor;
 * strong pixels, coherent structures and visible color areas are retained.
 * Size-only evidence is kept as one summary, with exact unnumbered rectangles
 * for drawing. It never consumes a content navigation number or region limit.
 */
export function findDifferenceRegions({
  width,
  height,
  contentWeights,
  outsideWeights,
  contentStrengths,
  maxRegions = DEFAULT_MAX_REGIONS,
}: RegionInput): DifferenceRegionResult {
  const pixelCount = width * height;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Number.isSafeInteger(pixelCount) ||
    contentWeights.length !== pixelCount ||
    outsideWeights.length !== pixelCount ||
    (contentStrengths !== undefined && contentStrengths.length !== pixelCount)
  ) {
    throw new Error("差异区域数据尺寸不一致");
  }

  const rawContentRegions = contentRegions(
    width,
    height,
    contentWeights,
    contentStrengths,
  );
  const rawOutsideAreas = outsideRegions(width, height, outsideWeights);
  const selected = selectRegions(rawContentRegions, maxRegions)
    .sort(
      (left, right) =>
        left.centerY - right.centerY ||
        left.centerX - right.centerX ||
        left.kind.localeCompare(right.kind),
    )
    .map<DifferenceRegion>((region, index) => ({
      id: `difference-region-${index + 1}`,
      kind: region.kind,
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      centerX: region.centerX,
      centerY: region.centerY,
      pixelCount: region.pixelCount,
    }));
  const outsideAreas = rawOutsideAreas
    .sort(
      (left, right) =>
        left.centerY - right.centerY || left.centerX - right.centerX,
    )
    .map<DifferenceRegion>((region, index) => ({
      id: `outside-area-${index + 1}`,
      kind: "outside",
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      centerX: region.centerX,
      centerY: region.centerY,
      pixelCount: region.pixelCount,
    }));
  const outsidePixelCount = outsideAreas.reduce(
    (total, area) => total + area.pixelCount,
    0,
  );

  return {
    regions: selected,
    totalRegions: rawContentRegions.length,
    hiddenRegions: Math.max(0, rawContentRegions.length - selected.length),
    outsideSummary:
      outsideAreas.length === 0
        ? null
        : {
            kind: "outside",
            pixelCount: outsidePixelCount,
            areaCount: outsideAreas.length,
            areas: outsideAreas,
          },
  };
}
