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
  regions: DifferenceRegion[];
  totalRegions: number;
  hiddenRegions: number;
};

type RegionInput = {
  width: number;
  height: number;
  contentWeights: Uint32Array;
  outsideWeights: Uint32Array;
  maxRegions?: number;
};

type RawRegion = Omit<DifferenceRegion, "id">;

const DEFAULT_MAX_REGIONS = 48;

/**
 * Groups nearby highlighted pixels into readable callout boxes. The grid keeps
 * a one-pixel change discoverable while preventing JPEG noise from producing
 * thousands of overlapping labels.
 */
export function findDifferenceRegions({
  width,
  height,
  contentWeights,
  outsideWeights,
  maxRegions = DEFAULT_MAX_REGIONS,
}: RegionInput): DifferenceRegionResult {
  const pixelCount = width * height;
  if (
    width <= 0 ||
    height <= 0 ||
    contentWeights.length !== pixelCount ||
    outsideWeights.length !== pixelCount
  ) {
    throw new Error("差异区域数据尺寸不一致");
  }

  const tileSize = Math.max(2, Math.round(Math.min(width, height) / 160));
  const tileColumns = Math.ceil(width / tileSize);
  const tileRows = Math.ceil(height / tileSize);
  const tileCount = tileColumns * tileRows;
  const flags = new Uint8Array(tileCount);
  const contentTileWeights = new Uint32Array(tileCount);
  const outsideTileWeights = new Uint32Array(tileCount);

  for (let y = 0; y < height; y += 1) {
    const tileY = Math.floor(y / tileSize);
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const tileIndex = tileY * tileColumns + Math.floor(x / tileSize);
      const contentWeight = contentWeights[pixelIndex];
      const outsideWeight = outsideWeights[pixelIndex];
      if (contentWeight > 0) {
        flags[tileIndex] |= 1;
        contentTileWeights[tileIndex] += contentWeight;
      }
      if (outsideWeight > 0) {
        flags[tileIndex] |= 2;
        outsideTileWeights[tileIndex] += outsideWeight;
      }
    }
  }

  const rawRegions: RawRegion[] = [];
  const directions = [-1, 0, 1];
  const pushRegion = (
    kind: DifferenceRegionKind,
    minTileX: number,
    minTileY: number,
    maxTileX: number,
    maxTileY: number,
    regionPixels: number,
  ) => {
    const padding = kind === "content" ? tileSize : Math.ceil(tileSize / 2);
    const left = Math.max(0, minTileX * tileSize - padding);
    const top = Math.max(0, minTileY * tileSize - padding);
    const right = Math.min(width, (maxTileX + 1) * tileSize + padding);
    const bottom = Math.min(height, (maxTileY + 1) * tileSize + padding);
    const regionWidth = right - left;
    const regionHeight = bottom - top;

    rawRegions.push({
      kind,
      x: left / width,
      y: top / height,
      width: regionWidth / width,
      height: regionHeight / height,
      centerX: (left + regionWidth / 2) / width,
      centerY: (top + regionHeight / 2) / height,
      pixelCount: regionPixels,
    });
  };

  // Content changes grow in eight directions so anti-aliased edges and nearby
  // pixels from the same visual edit become one readable callout.
  {
    const bit = 1;
    const tileWeights = contentTileWeights;
    const visited = new Uint8Array(tileCount);

    for (let start = 0; start < tileCount; start += 1) {
      if (visited[start] || (flags[start] & bit) === 0) continue;

      const queue = [start];
      visited[start] = 1;
      let cursor = 0;
      let minTileX = tileColumns;
      let minTileY = tileRows;
      let maxTileX = 0;
      let maxTileY = 0;
      let regionPixels = 0;

      while (cursor < queue.length) {
        const tileIndex = queue[cursor++];
        const tileX = tileIndex % tileColumns;
        const tileY = Math.floor(tileIndex / tileColumns);
        minTileX = Math.min(minTileX, tileX);
        minTileY = Math.min(minTileY, tileY);
        maxTileX = Math.max(maxTileX, tileX);
        maxTileY = Math.max(maxTileY, tileY);
        regionPixels += tileWeights[tileIndex];

        for (const offsetY of directions) {
          for (const offsetX of directions) {
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
            if (!visited[next] && (flags[next] & bit) !== 0) {
              visited[next] = 1;
              queue.push(next);
            }
          }
        }
      }

      pushRegion(
        "content",
        minTileX,
        minTileY,
        maxTileX,
        maxTileY,
        regionPixels,
      );
    }
  }

  // Size-only areas are normally rectangular bands. Extending equal row runs
  // vertically keeps an L-shaped right+bottom overhang as two honest boxes
  // instead of drawing one misleading frame around the entire image.
  type OutsideRun = {
    startX: number;
    endX: number;
    startY: number;
    endY: number;
    pixelCount: number;
  };
  let activeRuns = new Map<string, OutsideRun>();
  const finishRun = (run: OutsideRun) => {
    pushRegion(
      "outside",
      run.startX,
      run.startY,
      run.endX,
      run.endY,
      run.pixelCount,
    );
  };

  for (let tileY = 0; tileY < tileRows; tileY += 1) {
    const nextRuns = new Map<string, OutsideRun>();
    let tileX = 0;
    while (tileX < tileColumns) {
      const startIndex = tileY * tileColumns + tileX;
      if ((flags[startIndex] & 2) === 0) {
        tileX += 1;
        continue;
      }

      const startX = tileX;
      let runPixels = 0;
      while (
        tileX < tileColumns &&
        (flags[tileY * tileColumns + tileX] & 2) !== 0
      ) {
        runPixels += outsideTileWeights[tileY * tileColumns + tileX];
        tileX += 1;
      }
      const endX = tileX - 1;
      const key = `${startX}:${endX}`;
      const previous = activeRuns.get(key);
      nextRuns.set(
        key,
        previous
          ? {
              ...previous,
              endY: tileY,
              pixelCount: previous.pixelCount + runPixels,
            }
          : {
              startX,
              endX,
              startY: tileY,
              endY: tileY,
              pixelCount: runPixels,
            },
      );
    }

    for (const [key, run] of activeRuns) {
      if (!nextRuns.has(key)) finishRun(run);
    }
    activeRuns = nextRuns;
  }

  for (const run of activeRuns.values()) finishRun(run);

  const totalRegions = rawRegions.length;
  const selected = rawRegions
    .sort((left, right) => right.pixelCount - left.pixelCount)
    .slice(0, Math.max(1, maxRegions))
    .sort((left, right) => left.centerY - right.centerY || left.centerX - right.centerX)
    .map<DifferenceRegion>((region, index) => ({
      ...region,
      id: `difference-region-${index + 1}`,
    }));

  return {
    regions: selected,
    totalRegions,
    hiddenRegions: Math.max(0, totalRegions - selected.length),
  };
}
