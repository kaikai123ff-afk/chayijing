"use client";

/* Blob URLs and generated canvas previews are intentionally rendered locally. */
/* eslint-disable @next/next/no-img-element */

import {
  Fragment,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  findDifferenceRegions,
  type DifferenceRegion,
  type DifferenceRegionResult,
} from "./image-diff-regions";

type ImageSide = "left" | "right";
type ImageView = "side-by-side" | "slider" | "difference";
type Sensitivity = "low" | "standard" | "high";
type Alignment = "top-left" | "center";

type ImageAsset = {
  url: string;
  name: string;
  size: number;
  width: number;
  height: number;
};

type DiffStats = DifferenceRegionResult & {
  width: number;
  height: number;
  previewWidth: number;
  previewHeight: number;
  changedPixels: number;
  exactChangedPixels: number;
  overlapPixels: number;
  outsidePixels: number;
  differenceRate: number;
  leftPreview: string;
  rightPreview: string;
  differencePreview: string;
};

type ZoomPreviews = {
  leftSource: string;
  rightSource: string;
  regionId: string;
  left: string;
  right: string;
  rangeWidth: number;
  rangeHeight: number;
  regionBox: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};

type AnnotationLayerProps = {
  stats: DiffStats;
  activeRegion: number;
  onSelect: (index: number) => void;
  interactive?: boolean;
};

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 6_000_000;
const MAX_IMAGE_EDGE = 6000;
const MAX_COMPARE_PIXELS = 6_000_000;
const MAX_PREVIEW_EDGE = 1400;
const MAX_PREVIEW_PIXELS = 2_000_000;
const ANALYSIS_STRIPE_HEIGHT = 192;
const ZOOM_PREVIEW_WIDTH = 420;
const ZOOM_PREVIEW_HEIGHT = 280;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function describeRegionPosition(region: DifferenceRegion) {
  const horizontal =
    region.centerX < 0.34 ? "左侧" : region.centerX > 0.66 ? "右侧" : "中间";
  const vertical =
    region.centerY < 0.34 ? "上方" : region.centerY > 0.66 ? "下方" : "中部";
  return horizontal === "中间" && vertical === "中部"
    ? "画面中央"
    : `画面${vertical}${horizontal}`;
}

function describeDimensionDifference(left: ImageAsset, right: ImageAsset) {
  const widthDelta = right.width - left.width;
  const heightDelta = right.height - left.height;
  const parts: string[] = [];

  if (widthDelta !== 0) {
    parts.push(
      `新图片${widthDelta > 0 ? "宽" : "窄"} ${formatNumber(Math.abs(widthDelta))}px`,
    );
  }
  if (heightDelta !== 0) {
    parts.push(
      `新图片${heightDelta > 0 ? "高" : "矮"} ${formatNumber(Math.abs(heightDelta))}px`,
    );
  }

  return parts.join("、");
}

function computeZoomCrop(region: DifferenceRegion, width: number, height: number) {
  const targetAspect = 1.5;
  const regionWidth = Math.max(1, region.width * width);
  const regionHeight = Math.max(1, region.height * height);
  let cropWidth = Math.min(
    width,
    Math.max(regionWidth, Math.min(120, width), regionWidth * 2.8),
  );
  let cropHeight = Math.min(
    height,
    Math.max(regionHeight, Math.min(80, height), regionHeight * 2.8),
  );

  if (cropWidth / cropHeight < targetAspect) {
    const expandedWidth = cropHeight * targetAspect;
    if (expandedWidth <= width) cropWidth = Math.max(cropWidth, expandedWidth);
  } else {
    const expandedHeight = cropWidth / targetAspect;
    if (expandedHeight <= height) cropHeight = Math.max(cropHeight, expandedHeight);
  }

  const centerX = region.centerX * width;
  const centerY = region.centerY * height;
  const x = Math.max(0, Math.min(width - cropWidth, centerX - cropWidth / 2));
  const y = Math.max(0, Math.min(height - cropHeight, centerY - cropHeight / 2));

  return { x, y, width: cropWidth, height: cropHeight };
}

function zoomViewport(crop: ReturnType<typeof computeZoomCrop>) {
  const scale = Math.min(
    ZOOM_PREVIEW_WIDTH / crop.width,
    ZOOM_PREVIEW_HEIGHT / crop.height,
  );
  const width = crop.width * scale;
  const height = crop.height * scale;
  return {
    scale,
    x: (ZOOM_PREVIEW_WIDTH - width) / 2,
    y: (ZOOM_PREVIEW_HEIGHT - height) / 2,
    width,
    height,
  };
}

async function createZoomPreview(
  source: string,
  crop: ReturnType<typeof computeZoomCrop>,
) {
  const image = await loadHtmlImage(source);
  const canvas = createCanvas(ZOOM_PREVIEW_WIDTH, ZOOM_PREVIEW_HEIGHT);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建局部放大图");
  const viewport = zoomViewport(crop);
  context.imageSmoothingEnabled = viewport.scale < 1;
  if (context.imageSmoothingEnabled) context.imageSmoothingQuality = "high";
  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    viewport.x,
    viewport.y,
    viewport.width,
    viewport.height,
  );
  return canvas.toDataURL("image/png");
}

function DifferenceZoomComparison({
  activeRegion,
  selectedRegion,
  zoomPreviews,
}: {
  activeRegion: number;
  selectedRegion: DifferenceRegion | null;
  zoomPreviews: ZoomPreviews | null;
}) {
  if (!selectedRegion) return null;

  return (
    <section className="difference-zoom" aria-label="当前差异局部放大">
      <div className="difference-zoom-heading">
        <div>
          <span>第 {activeRegion + 1} 处 · {describeRegionPosition(selectedRegion)}</span>
          <strong>原图与新图局部放大</strong>
        </div>
        {zoomPreviews ? (
          <small>
            局部范围 {formatNumber(zoomPreviews.rangeWidth)}×{formatNumber(zoomPreviews.rangeHeight)}px
          </small>
        ) : null}
      </div>
      {zoomPreviews ? (
        <div className="difference-zoom-grid">
          {([
            ["原始图片", zoomPreviews.left],
            ["新图片", zoomPreviews.right],
          ] as const).map(([label, source]) => (
            <figure key={label}>
              <figcaption>{label}</figcaption>
              <div className="difference-zoom-image checkerboard">
                <img src={source} alt={`${label}第 ${activeRegion + 1} 处局部放大`} />
                <span
                  className="difference-zoom-box"
                  style={{
                    left: `${zoomPreviews.regionBox.left}%`,
                    top: `${zoomPreviews.regionBox.top}%`,
                    width: `${zoomPreviews.regionBox.width}%`,
                    height: `${zoomPreviews.regionBox.height}%`,
                  }}
                  aria-hidden="true"
                />
              </div>
            </figure>
          ))}
        </div>
      ) : (
        <p className="difference-zoom-loading">正在生成局部放大对照…</p>
      )}
    </section>
  );
}

function DifferenceAnnotations({
  stats,
  activeRegion,
  onSelect,
  interactive = true,
}: AnnotationLayerProps) {
  const dense = stats.regions.length > 18;

  return stats.regions.map((region, index) => {
    const isActive = index === activeRegion;
    const markerLeft = Math.max(
      0.025,
      Math.min(0.975, region.x + Math.min(region.width * 0.12, 0.012)),
    );
    const markerTop = Math.max(
      0.025,
      Math.min(
        0.975,
        region.y > 0.07
          ? region.y - 0.018
          : region.y + Math.min(region.height * 0.15, 0.02),
      ),
    );

    return (
      <Fragment key={region.id}>
        <span
          className={`difference-region-box ${region.kind} ${
            isActive ? "active" : dense ? "dense-muted" : ""
          }`}
          style={{
            left: `${region.x * 100}%`,
            top: `${region.y * 100}%`,
            width: `${region.width * 100}%`,
            height: `${region.height * 100}%`,
          }}
          aria-hidden="true"
        />
        {dense && !isActive ? null : interactive ? (
          <button
            className={`difference-marker ${region.kind} ${
              isActive ? "active" : ""
            }`}
            style={{
              left: `clamp(24px, ${markerLeft * 100}%, calc(100% - 24px))`,
              top: `clamp(24px, ${markerTop * 100}%, calc(100% - 24px))`,
            }}
            type="button"
            onClick={() => onSelect(index)}
            aria-label={`第 ${index + 1} 处，肉眼可见内容差异，${describeRegionPosition(region)}`}
            aria-pressed={isActive}
            tabIndex={isActive ? 0 : -1}
          >
            <span>{index + 1}</span>
          </button>
        ) : (
          <span
            className={`difference-marker visual-only ${region.kind} ${
              isActive ? "active" : ""
            }`}
            style={{
              left: `clamp(24px, ${markerLeft * 100}%, calc(100% - 24px))`,
              top: `clamp(24px, ${markerTop * 100}%, calc(100% - 24px))`,
            }}
            aria-hidden="true"
          >
            <span>{index + 1}</span>
          </span>
        )}
      </Fragment>
    );
  });
}

function DifferenceNavigation({
  stats,
  activeRegion,
  selectedRegion,
  onMove,
}: {
  stats: DiffStats;
  activeRegion: number;
  selectedRegion: DifferenceRegion | null;
  onMove: (direction: number) => void;
}) {
  if (stats.regions.length === 0) return null;

  return (
    <div className="difference-navigation" aria-label="差异位置导航">
      <button
        type="button"
        onClick={() => onMove(-1)}
        disabled={activeRegion === 0}
        aria-label="上一处图片差异"
      >
        ← 上一处
      </button>
      <p aria-live="polite">
        <strong>
          {activeRegion + 1} / {stats.regions.length}
        </strong>
        <span>
          {stats.regions.length > 18 ? "差异较多，当前只显示此编号" : "肉眼可见内容差异"}
          {selectedRegion ? ` · ${describeRegionPosition(selectedRegion)}` : ""}
        </span>
      </p>
      <button
        type="button"
        onClick={() => onMove(1)}
        disabled={activeRegion === stats.regions.length - 1}
        aria-label="下一处图片差异"
      >
        下一处 →
      </button>
    </div>
  );
}

function loadHtmlImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("无法解码图片"));
    image.src = url;
  });
}

async function createImageAsset(file: File): Promise<ImageAsset> {
  if (!ALLOWED_TYPES.has(file.type)) {
    throw new Error("请选择 PNG、JPG 或 WebP 图片");
  }
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("单张图片不能超过 20 MB");
  }

  const url = URL.createObjectURL(file);
  try {
    const image = await loadHtmlImage(url);
    if (
      image.naturalWidth > MAX_IMAGE_EDGE ||
      image.naturalHeight > MAX_IMAGE_EDGE ||
      image.naturalWidth * image.naturalHeight > MAX_IMAGE_PIXELS
    ) {
      throw new Error("图片尺寸过大，请将单张图片控制在 600 万像素以内");
    }
    return {
      url,
      name: file.name,
      size: file.size,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error instanceof Error
      ? error
      : new Error("无法读取此图片，请更换文件后重试");
  }
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function imageOffset(
  canvasWidth: number,
  canvasHeight: number,
  imageWidth: number,
  imageHeight: number,
  alignment: Alignment,
) {
  if (alignment === "top-left") return { x: 0, y: 0 };
  return {
    x: Math.floor((canvasWidth - imageWidth) / 2),
    y: Math.floor((canvasHeight - imageHeight) / 2),
  };
}

function previewDimensions(width: number, height: number) {
  const edgeScale = Math.min(1, MAX_PREVIEW_EDGE / Math.max(width, height));
  const pixelScale = Math.min(
    1,
    Math.sqrt(MAX_PREVIEW_PIXELS / (width * height)),
  );
  const scale = Math.min(edgeScale, pixelScale);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function canvasPreview(
  source: HTMLCanvasElement,
  width: number,
  height: number,
) {
  const preview = createCanvas(width, height);
  const context = preview.getContext("2d");
  if (!context) throw new Error("浏览器无法创建图片预览");
  context.drawImage(source, 0, 0, width, height);
  return preview.toDataURL("image/png");
}

function visualColorDifference(
  leftData: Uint8ClampedArray,
  rightData: Uint8ClampedArray,
  offset: number,
) {
  const leftAlpha = leftData[offset + 3] / 255;
  const rightAlpha = rightData[offset + 3] / 255;
  const distanceOnBackground = (background: number) => {
    const channelDifference = (channel: number) => {
      const left = leftData[offset + channel] * leftAlpha + background * (1 - leftAlpha);
      const right = rightData[offset + channel] * rightAlpha + background * (1 - rightAlpha);
      return left - right;
    };
    const red = channelDifference(0);
    const green = channelDifference(1);
    const blue = channelDifference(2);
    return Math.sqrt(0.2126 * red * red + 0.7152 * green * green + 0.0722 * blue * blue);
  };

  // Weighted RGB distance follows perceived brightness more closely than the
  // largest raw channel delta. Fully transparent hidden RGB therefore does not
  // create a false visual change. Both checkerboard tones preserve visible
  // transparency changes that disappear against only one background.
  return Math.min(
    255,
    Math.round(Math.max(distanceOnBackground(230), distanceOnBackground(245))),
  );
}

function analyzeImages(
  leftImage: HTMLImageElement,
  rightImage: HTMLImageElement,
  sensitivity: Sensitivity,
  alignment: Alignment,
): DiffStats {
  const width = Math.max(leftImage.naturalWidth, rightImage.naturalWidth);
  const height = Math.max(leftImage.naturalHeight, rightImage.naturalHeight);
  if (width * height > MAX_COMPARE_PIXELS) {
    throw new Error("对齐后的比较画布超过 600 万像素，请缩小图片后重试");
  }

  const leftWidth = leftImage.naturalWidth;
  const leftHeight = leftImage.naturalHeight;
  const rightWidth = rightImage.naturalWidth;
  const rightHeight = rightImage.naturalHeight;
  const leftOffset = imageOffset(
    width,
    height,
    leftWidth,
    leftHeight,
    alignment,
  );
  const rightOffset = imageOffset(
    width,
    height,
    rightWidth,
    rightHeight,
    alignment,
  );
  const leftCanvas = createCanvas(width, height);
  const rightCanvas = createCanvas(width, height);
  const leftContext = leftCanvas.getContext("2d", { willReadFrequently: true });
  const rightContext = rightCanvas.getContext("2d", { willReadFrequently: true });
  if (!leftContext || !rightContext) throw new Error("浏览器无法创建图片画布");

  leftContext.drawImage(
    leftImage,
    leftOffset.x,
    leftOffset.y,
    leftWidth,
    leftHeight,
  );
  rightContext.drawImage(
    rightImage,
    rightOffset.x,
    rightOffset.y,
    rightWidth,
    rightHeight,
  );

  const preview = previewDimensions(width, height);
  const differenceCanvas = createCanvas(preview.width, preview.height);
  const differenceContext = differenceCanvas.getContext("2d");
  if (!differenceContext) throw new Error("浏览器无法创建差异画布");
  const differenceData = differenceContext.createImageData(
    preview.width,
    preview.height,
  );
  const contentWeights = new Uint32Array(preview.width * preview.height);
  const outsideWeights = new Uint32Array(preview.width * preview.height);
  const contentStrengths = new Uint8Array(preview.width * preview.height);
  const threshold = sensitivity === "high" ? 0 : sensitivity === "standard" ? 18 : 42;
  let changedPixels = 0;
  let exactChangedPixels = 0;
  let overlapPixels = 0;
  let outsidePixels = 0;

  const markDifference = (
    x: number,
    y: number,
    red: number,
    green: number,
    blue: number,
    alpha: number,
    kind: "content" | "outside",
    strength = 0,
  ) => {
    const previewX = Math.min(
      preview.width - 1,
      Math.floor((x / width) * preview.width),
    );
    const previewY = Math.min(
      preview.height - 1,
      Math.floor((y / height) * preview.height),
    );
    const previewOffset = (previewY * preview.width + previewX) * 4;
    const previewIndex = previewY * preview.width + previewX;
    if (kind === "content") {
      contentWeights[previewIndex] += 1;
      contentStrengths[previewIndex] = Math.max(
        contentStrengths[previewIndex],
        strength,
      );
    } else {
      outsideWeights[previewIndex] += 1;
    }
    const contentAlreadyMarked = contentWeights[previewIndex] > 0;
    if (kind === "content" || !contentAlreadyMarked) {
      differenceData.data[previewOffset] = red;
      differenceData.data[previewOffset + 1] = green;
      differenceData.data[previewOffset + 2] = blue;
    }
    differenceData.data[previewOffset + 3] = Math.max(
      differenceData.data[previewOffset + 3],
      alpha,
    );
  };

  for (let stripeY = 0; stripeY < height; stripeY += ANALYSIS_STRIPE_HEIGHT) {
    const stripeHeight = Math.min(ANALYSIS_STRIPE_HEIGHT, height - stripeY);
    const leftData = leftContext.getImageData(0, stripeY, width, stripeHeight);
    const rightData = rightContext.getImageData(0, stripeY, width, stripeHeight);

    for (let y = 0; y < stripeHeight; y += 1) {
      const canvasY = stripeY + y;
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        const leftPresent =
          x >= leftOffset.x &&
          x < leftOffset.x + leftWidth &&
          canvasY >= leftOffset.y &&
          canvasY < leftOffset.y + leftHeight;
        const rightPresent =
          x >= rightOffset.x &&
          x < rightOffset.x + rightWidth &&
          canvasY >= rightOffset.y &&
          canvasY < rightOffset.y + rightHeight;

        if (leftPresent && rightPresent) {
          overlapPixels += 1;
          const exactDelta = Math.max(
            Math.abs(leftData.data[offset] - rightData.data[offset]),
            Math.abs(leftData.data[offset + 1] - rightData.data[offset + 1]),
            Math.abs(leftData.data[offset + 2] - rightData.data[offset + 2]),
            Math.abs(leftData.data[offset + 3] - rightData.data[offset + 3]),
          );
          const visualDelta = visualColorDifference(
            leftData.data,
            rightData.data,
            offset,
          );
          if (exactDelta > 0) exactChangedPixels += 1;
          if (visualDelta > threshold) {
            changedPixels += 1;
            markDifference(
              x,
              canvasY,
              236,
              35,
              116,
              Math.min(245, 150 + visualDelta),
              "content",
              visualDelta,
            );
          }
        } else if (leftPresent || rightPresent) {
          outsidePixels += 1;
          markDifference(x, canvasY, 242, 148, 24, 205, "outside");
        }
      }
    }
  }

  differenceContext.putImageData(differenceData, 0, 0);
  const regionResult = findDifferenceRegions({
    width: preview.width,
    height: preview.height,
    contentWeights,
    outsideWeights,
    contentStrengths,
  });
  return {
    width,
    height,
    previewWidth: preview.width,
    previewHeight: preview.height,
    changedPixels,
    exactChangedPixels,
    overlapPixels,
    outsidePixels,
    differenceRate:
      overlapPixels === 0 ? 0 : (changedPixels / overlapPixels) * 100,
    ...regionResult,
    leftPreview: canvasPreview(leftCanvas, preview.width, preview.height),
    rightPreview: canvasPreview(rightCanvas, preview.width, preview.height),
    differencePreview: differenceCanvas.toDataURL("image/png"),
  };
}

function UploadCard({
  side,
  asset,
  error,
  onFile,
  onRemove,
}: {
  side: ImageSide;
  asset: ImageAsset | null;
  error: string;
  onFile: (side: ImageSide, file: File) => void;
  onRemove: (side: ImageSide) => void;
}) {
  const inputId = `${side}-image-file`;
  const roleName = side === "left" ? "原始图片" : "新图片";
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) onFile(side, file);
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) onFile(side, file);
    event.target.value = "";
  };

  return (
    <article
      className={`image-upload-card ${asset ? "has-image" : ""} ${
        dragging ? "is-dragging" : ""
      }`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDragging(false);
        }
      }}
      onDrop={handleDrop}
    >
      <div className="image-upload-heading">
        <span className={`side-label ${side === "left" ? "before-label" : "after-label"}`}>
          {roleName}
        </span>
        {asset ? (
          <span className="image-dimensions">
            {asset.width} × {asset.height}
          </span>
        ) : null}
      </div>

      <button
        className="image-dropzone"
        type="button"
        onClick={() => inputRef.current?.click()}
        aria-label={asset ? `替换${roleName}` : `选择${roleName}`}
      >
        {asset ? (
          <img src={asset.url} alt={`${roleName}：${asset.name}`} />
        ) : (
          <span className="image-upload-empty">
            <span className="upload-symbol" aria-hidden="true">＋</span>
            <strong>拖入图片，或点击选择</strong>
            <small>PNG / JPG / WebP · ≤20 MB / 600 万像素</small>
          </span>
        )}
        {dragging ? <span className="drop-overlay">松开以放入{roleName}</span> : null}
      </button>
      <input
        id={inputId}
        ref={inputRef}
        className="file-input"
        type="file"
        tabIndex={-1}
        accept="image/png,image/jpeg,image/webp"
        onChange={handleInput}
      />

      {asset ? (
        <div className="image-file-row">
          <span className="image-file-copy" title={asset.name}>
            <strong>{asset.name}</strong>
            <small>{formatBytes(asset.size)}</small>
          </span>
          <span className="image-card-actions">
            <button className="mini-action" type="button" onClick={() => inputRef.current?.click()}>替换</button>
            <button className="mini-action danger" type="button" onClick={() => onRemove(side)}>
              移除
            </button>
          </span>
        </div>
      ) : null}
      <p className="image-error" aria-live="polite">{error}</p>
    </article>
  );
}

export function ImageCompare() {
  const [leftAsset, setLeftAsset] = useState<ImageAsset | null>(null);
  const [rightAsset, setRightAsset] = useState<ImageAsset | null>(null);
  const [leftError, setLeftError] = useState("");
  const [rightError, setRightError] = useState("");
  const [view, setView] = useState<ImageView>("difference");
  const [sliderPosition, setSliderPosition] = useState(50);
  const [sensitivity, setSensitivity] = useState<Sensitivity>("standard");
  const [alignment, setAlignment] = useState<Alignment>("top-left");
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [processing, setProcessing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [activeRegion, setActiveRegion] = useState(0);
  const [zoomPreviews, setZoomPreviews] = useState<ZoomPreviews | null>(null);
  const deferredSensitivity = useDeferredValue(sensitivity);
  const deferredAlignment = useDeferredValue(alignment);
  const leftRef = useRef<ImageAsset | null>(null);
  const rightRef = useRef<ImageAsset | null>(null);
  const leftGeneration = useRef(0);
  const rightGeneration = useRef(0);

  useEffect(() => {
    leftRef.current = leftAsset;
  }, [leftAsset]);

  useEffect(() => {
    rightRef.current = rightAsset;
  }, [rightAsset]);

  useEffect(
    () => () => {
      leftGeneration.current += 1;
      rightGeneration.current += 1;
      if (leftRef.current) URL.revokeObjectURL(leftRef.current.url);
      if (rightRef.current) URL.revokeObjectURL(rightRef.current.url);
    },
    [],
  );

  useEffect(() => {
    if (!leftAsset || !rightAsset) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled) return;
      setProcessing(true);
      setAnalysisError("");
      try {
        const [leftImage, rightImage] = await Promise.all([
          loadHtmlImage(leftAsset.url),
          loadHtmlImage(rightAsset.url),
        ]);
        const result = analyzeImages(
          leftImage,
          rightImage,
          deferredSensitivity,
          deferredAlignment,
        );
        if (!cancelled) {
          setStats(result);
          setActiveRegion(0);
        }
      } catch (error) {
        if (!cancelled) {
          setStats(null);
          setAnalysisError(
            error instanceof Error
              ? error.message
              : "图片分析失败，请重新选择图片后重试",
          );
        }
      } finally {
        if (!cancelled) setProcessing(false);
      }
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [leftAsset, rightAsset, deferredSensitivity, deferredAlignment]);

  const setAsset = async (side: ImageSide, file: File) => {
    const setError = side === "left" ? setLeftError : setRightError;
    const generation = side === "left" ? leftGeneration : rightGeneration;
    const requestId = generation.current + 1;
    generation.current = requestId;
    setError("");
    try {
      const nextAsset = await createImageAsset(file);
      if (generation.current !== requestId) {
        URL.revokeObjectURL(nextAsset.url);
        return;
      }
      setStats(null);
      setProcessing(true);
      setAnalysisError("");
      if (side === "left") {
        setLeftAsset((current) => {
          if (current) URL.revokeObjectURL(current.url);
          return nextAsset;
        });
      } else {
        setRightAsset((current) => {
          if (current) URL.revokeObjectURL(current.url);
          return nextAsset;
        });
      }
    } catch (error) {
      if (generation.current !== requestId) return;
      setError(error instanceof Error ? error.message : "无法读取此图片");
    }
  };

  const removeAsset = (side: ImageSide) => {
    if (side === "left") {
      leftGeneration.current += 1;
      setLeftAsset((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return null;
      });
      setLeftError("");
      setStats(null);
      setProcessing(false);
      setAnalysisError("");
    } else {
      rightGeneration.current += 1;
      setRightAsset((current) => {
        if (current) URL.revokeObjectURL(current.url);
        return null;
      });
      setRightError("");
      setStats(null);
      setProcessing(false);
      setAnalysisError("");
    }
  };

  const swapAssets = () => {
    leftGeneration.current += 1;
    rightGeneration.current += 1;
    setLeftAsset(rightAsset);
    setRightAsset(leftAsset);
    setLeftError(rightError);
    setRightError(leftError);
    setStats(null);
    setProcessing(Boolean(leftAsset && rightAsset));
    setAnalysisError("");
  };

  const clearAssets = () => {
    leftGeneration.current += 1;
    rightGeneration.current += 1;
    if (leftAsset) URL.revokeObjectURL(leftAsset.url);
    if (rightAsset) URL.revokeObjectURL(rightAsset.url);
    setLeftAsset(null);
    setRightAsset(null);
    setLeftError("");
    setRightError("");
    setStats(null);
    setProcessing(false);
    setAnalysisError("");
  };

  const dimensionsDiffer = Boolean(
    leftAsset &&
      rightAsset &&
      (leftAsset.width !== rightAsset.width || leftAsset.height !== rightAsset.height),
  );
  const exactMatch = Boolean(
    stats && stats.exactChangedPixels === 0 && stats.outsidePixels === 0,
  );
  const hasVisibleContentDifference = Boolean(
    stats?.regions.some((region) => region.kind === "content"),
  );
  const noDetectedContentDifference = Boolean(
    stats && !hasVisibleContentDifference,
  );
  const selectedRegion = stats?.regions[activeRegion] ?? null;

  useEffect(() => {
    if (!stats || !selectedRegion) return;

    let cancelled = false;
    const crop = computeZoomCrop(
      selectedRegion,
      stats.previewWidth,
      stats.previewHeight,
    );
    Promise.all([
      createZoomPreview(stats.leftPreview, crop),
      createZoomPreview(stats.rightPreview, crop),
    ])
      .then(([left, right]) => {
        if (cancelled) return;
        const regionX = selectedRegion.x * stats.previewWidth;
        const regionY = selectedRegion.y * stats.previewHeight;
        const regionWidth = selectedRegion.width * stats.previewWidth;
        const regionHeight = selectedRegion.height * stats.previewHeight;
        const viewport = zoomViewport(crop);
        const leftEdge = Math.max(
          0,
          Math.min(
            ZOOM_PREVIEW_WIDTH,
            viewport.x + (regionX - crop.x) * viewport.scale,
          ),
        );
        const topEdge = Math.max(
          0,
          Math.min(
            ZOOM_PREVIEW_HEIGHT,
            viewport.y + (regionY - crop.y) * viewport.scale,
          ),
        );
        const rightEdge = Math.max(
          leftEdge,
          Math.min(
            ZOOM_PREVIEW_WIDTH,
            viewport.x + (regionX + regionWidth - crop.x) * viewport.scale,
          ),
        );
        const bottomEdge = Math.max(
          topEdge,
          Math.min(
            ZOOM_PREVIEW_HEIGHT,
            viewport.y + (regionY + regionHeight - crop.y) * viewport.scale,
          ),
        );
        setZoomPreviews({
          leftSource: stats.leftPreview,
          rightSource: stats.rightPreview,
          regionId: selectedRegion.id,
          left,
          right,
          rangeWidth: Math.max(
            1,
            Math.round(crop.width * (stats.width / stats.previewWidth)),
          ),
          rangeHeight: Math.max(
            1,
            Math.round(crop.height * (stats.height / stats.previewHeight)),
          ),
          regionBox: {
            left: (leftEdge / ZOOM_PREVIEW_WIDTH) * 100,
            top: (topEdge / ZOOM_PREVIEW_HEIGHT) * 100,
            width: ((rightEdge - leftEdge) / ZOOM_PREVIEW_WIDTH) * 100,
            height: ((bottomEdge - topEdge) / ZOOM_PREVIEW_HEIGHT) * 100,
          },
        });
      })
      .catch(() => {
        if (!cancelled) {
          setZoomPreviews((current) =>
            current?.leftSource === stats.leftPreview &&
            current.rightSource === stats.rightPreview &&
            current.regionId === selectedRegion.id
              ? null
              : current,
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRegion, stats]);

  const currentZoomPreviews =
    zoomPreviews !== null &&
    zoomPreviews.leftSource === stats?.leftPreview &&
    zoomPreviews.rightSource === stats?.rightPreview &&
    zoomPreviews.regionId === selectedRegion?.id
      ? zoomPreviews
      : null;

  const moveRegion = (direction: number) => {
    if (!stats || stats.regions.length === 0) return;
    setActiveRegion(
      (current) =>
        Math.max(0, Math.min(stats.regions.length - 1, current + direction)),
    );
  };

  const handleSliderKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const step = event.shiftKey ? 10 : 1;
    setSliderPosition((current) => Math.max(0, Math.min(100, current + direction * step)));
  };

  return (
    <>
      <section className="workbench image-workbench" aria-label="图片对比工作台">
        <div className="workbench-toolbar">
          <div className="live-badge">
            <span aria-hidden="true">◉</span>
            本地实时对比
          </div>
          <div className="toolbar-actions">
            <button className="text-button" onClick={swapAssets} type="button" disabled={!leftAsset && !rightAsset}>
              <span aria-hidden="true">⇄</span> 交换两侧
            </button>
            <button className="text-button danger" onClick={clearAssets} type="button" disabled={!leftAsset && !rightAsset}>
              清空
            </button>
          </div>
        </div>
        <div className="image-upload-grid">
          <UploadCard side="left" asset={leftAsset} error={leftError} onFile={setAsset} onRemove={removeAsset} />
          <UploadCard side="right" asset={rightAsset} error={rightError} onFile={setAsset} onRemove={removeAsset} />
        </div>
      </section>

      <section className="results image-results" aria-labelledby="image-results-title">
        <div className="results-topline">
          <div>
            <span className="section-index">02 / 图片对比结果</span>
            <h2 id="image-results-title">
              {!leftAsset && !rightAsset
                ? "等待两张图片"
                : !leftAsset
                  ? "还差一张原始图片"
                  : !rightAsset
                    ? "还差一张新图片"
                    : processing
                      ? "正在本地分析…"
                      : exactMatch
                        ? "两张图片像素完全一致"
                        : dimensionsDiffer && noDetectedContentDifference
                          ? "重叠区域未见明显变化，但图片尺寸不同"
                          : noDetectedContentDifference
                            ? "肉眼标准下未发现明显差异"
                            : "图片差异已标出"}
            </h2>
          </div>
          {stats ? (
            <div className={`match-status ${exactMatch ? "identical" : "changed"}`}>
              <span aria-hidden="true">{exactMatch ? "✓" : "!"}</span>
              {exactMatch
                ? "没有差异"
                : dimensionsDiffer && noDetectedContentDifference
                  ? "仅尺寸不同"
                  : noDetectedContentDifference
                    ? "未发现明显内容差异"
                    : "发现内容差异"}
            </div>
          ) : null}
        </div>

        {leftAsset && rightAsset && stats ? (
          <>
            <div className="image-summary" aria-label="图片差异统计">
              <div className="image-stat">
                <strong>{formatNumber(stats.totalRegions)}</strong>
                <span>肉眼可见内容差异</span>
              </div>
              <div className="image-stat accent">
                <strong>{hasVisibleContentDifference ? "有" : "未发现"}</strong>
                <span>肉眼可见内容变化</span>
              </div>
              <div className="image-stat">
                <strong>{dimensionsDiffer ? "有" : "无"}</strong>
                <span>图片尺寸范围变化</span>
              </div>
              <div className="image-stat image-size-stat">
                <strong>{dimensionsDiffer ? "不同" : "一致"}</strong>
                <span>
                  {leftAsset.width}×{leftAsset.height} / {rightAsset.width}×{rightAsset.height}
                </span>
              </div>
            </div>
            {dimensionsDiffer ? (
              <div className="dimension-notice">
                <span aria-hidden="true">i</span>
                <div>
                  <strong>{describeDimensionDifference(leftAsset, rightAsset)}</strong>
                  <p>
                    原始 {leftAsset.width}×{leftAsset.height}px / 新图 {rightAsset.width}×{rightAsset.height}px；
                    当前按原始像素{alignment === "top-left" ? "左上" : "居中"}对齐。在“差异高亮”视图中，橙色边带只表示多出的画布范围，不参与内容差异编号。
                  </p>
                </div>
              </div>
            ) : null}
            <div className="result-toolbar image-result-toolbar">
              <div className="segmented image-view-tabs" aria-label="图片结果视图">
                {([
                  ["side-by-side", "并排"],
                  ["slider", "滑杆"],
                  ["difference", "差异高亮"],
                ] as const).map(([value, label]) => (
                  <button
                    className={view === value ? "active" : ""}
                    key={value}
                    onClick={() => setView(value)}
                    type="button"
                    aria-pressed={view === value}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="image-controls">
                {dimensionsDiffer ? (
                  <div className="compact-control" aria-label="图片对齐方式">
                    <span>对齐</span>
                    <button className={alignment === "top-left" ? "active" : ""} aria-pressed={alignment === "top-left"} onClick={() => {
                      if (alignment === "top-left") return;
                      setStats(null);
                      setProcessing(true);
                      setAlignment("top-left");
                    }} type="button">左上</button>
                    <button className={alignment === "center" ? "active" : ""} aria-pressed={alignment === "center"} onClick={() => {
                      if (alignment === "center") return;
                      setStats(null);
                      setProcessing(true);
                      setAlignment("center");
                    }} type="button">居中</button>
                  </div>
                ) : null}
                {view === "difference" || view === "side-by-side" ? (
                  <div className="compact-control" aria-label="差异识别标准">
                    <span>识别标准</span>
                    {(["low", "standard", "high"] as const).map((value) => (
                      <button
                        className={sensitivity === value ? "active" : ""}
                        key={value}
                        aria-pressed={sensitivity === value}
                        onClick={() => {
                          if (sensitivity === value) return;
                          setStats(null);
                          setProcessing(true);
                          setSensitivity(value);
                        }}
                        type="button"
                      >
                        {value === "low" ? "明显" : value === "standard" ? "肉眼可见" : "细微"}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

        <div className="image-result-stage">
          {!leftAsset || !rightAsset ? (
            <div className="empty-state">
              <span aria-hidden="true">▧</span>
              <strong>{!leftAsset && !rightAsset ? "上传两张图片开始对比" : "再上传另一张图片"}</strong>
              <p>图片只在当前浏览器中解码和分析，不会上传。</p>
            </div>
          ) : analysisError ? (
            <div className="empty-state compact" role="alert">
              <span aria-hidden="true">!</span>
              <strong>图片分析失败</strong>
              <p>{analysisError}</p>
            </div>
          ) : processing || !stats ? (
            <div className="empty-state compact processing-state" role="status" aria-live="polite">
              <span aria-hidden="true">◌</span>
              <strong>正在本地分析图片</strong>
              <p>大尺寸图片可能需要几秒钟。</p>
            </div>
          ) : view === "side-by-side" ? (
            <div className="side-by-side-viewer">
              <DifferenceNavigation
                stats={stats}
                activeRegion={activeRegion}
                selectedRegion={selectedRegion}
                onMove={moveRegion}
              />
              <DifferenceZoomComparison
                activeRegion={activeRegion}
                selectedRegion={selectedRegion}
                zoomPreviews={currentZoomPreviews}
              />
              <div className="image-side-by-side">
                <figure>
                  <figcaption>原始图片 · 同编号对应右侧同一处</figcaption>
                  <div className="checkerboard image-annotated-shell">
                    <div
                      className="image-annotation-stage"
                      style={{ aspectRatio: `${stats.previewWidth} / ${stats.previewHeight}` }}
                    >
                      <img src={stats.leftPreview} alt={`原始图片：${leftAsset.name}`} />
                      <DifferenceAnnotations
                        stats={stats}
                        activeRegion={activeRegion}
                        onSelect={setActiveRegion}
                        interactive={false}
                      />
                    </div>
                  </div>
                </figure>
                <figure>
                  <figcaption>新图片 · 点击编号查看对应差异</figcaption>
                  <div className="checkerboard image-annotated-shell">
                    <div
                      className="image-annotation-stage"
                      style={{ aspectRatio: `${stats.previewWidth} / ${stats.previewHeight}` }}
                    >
                      <img src={stats.rightPreview} alt={`新图片：${rightAsset.name}`} />
                      <DifferenceAnnotations
                        stats={stats}
                        activeRegion={activeRegion}
                        onSelect={setActiveRegion}
                      />
                    </div>
                  </div>
                </figure>
              </div>
              <p className="side-by-side-hint">两栏用相同编号标出同一处变化；“上一处 / 下一处”会同步高亮。</p>
            </div>
          ) : view === "slider" ? (
            <div className="image-slider-shell">
              <div
                className="image-slider-stage checkerboard"
                style={{
                  aspectRatio: `${stats.previewWidth} / ${stats.previewHeight}`,
                  maxWidth: `${Math.max(44, (670 * stats.previewWidth) / stats.previewHeight)}px`,
                }}
              >
                <img src={stats.leftPreview} alt={`原始图片：${leftAsset.name}`} />
                <div className="slider-new-layer" style={{ clipPath: `inset(0 ${100 - sliderPosition}% 0 0)` }}>
                  <img src={stats.rightPreview} alt={`新图片：${rightAsset.name}`} />
                </div>
                <span className="image-corner-label old">原始</span>
                <span className="image-corner-label new">新图片</span>
                <span className="image-slider-line" style={{ left: `${sliderPosition}%` }} aria-hidden="true">
                  <i>↔</i>
                </span>
                <input
                  className="image-slider-input"
                  type="range"
                  min="0"
                  max="100"
                  value={sliderPosition}
                  onChange={(event) => setSliderPosition(Number(event.target.value))}
                  onKeyDown={handleSliderKey}
                  aria-label="新图片显示范围"
                  aria-valuetext={`${sliderPosition}%`}
                />
              </div>
              <p>拖动滑杆，左右查看同一位置的原始图片和新图片。</p>
            </div>
          ) : (
            <div className="difference-viewer">
              <DifferenceNavigation
                stats={stats}
                activeRegion={activeRegion}
                selectedRegion={selectedRegion}
                onMove={moveRegion}
              />
              <DifferenceZoomComparison
                activeRegion={activeRegion}
                selectedRegion={selectedRegion}
                zoomPreviews={currentZoomPreviews}
              />
              <div
                className="difference-stage checkerboard"
                style={{
                  aspectRatio: `${stats.previewWidth} / ${stats.previewHeight}`,
                  maxWidth: `${Math.max(44, (670 * stats.previewWidth) / stats.previewHeight)}px`,
                }}
              >
                <img className="difference-base" src={stats.rightPreview} alt={`新图片底图：${rightAsset.name}`} />
                <img className="difference-overlay" src={stats.differencePreview} alt="图片内容差异与尺寸范围高亮图" />
                <DifferenceAnnotations
                  stats={stats}
                  activeRegion={activeRegion}
                  onSelect={setActiveRegion}
                />
              </div>
              {stats.hiddenRegions > 0 ? (
                <p className="hidden-regions-note">
                  已标出显著度最高的 {stats.regions.length} 处；另有 {stats.hiddenRegions} 处显著度较低的差异仍保留高亮，但未显示编号和方框。
                </p>
              ) : null}
              <div className="difference-legend">
                <span><i className="difference-pink" />肉眼可见内容差异</span>
                <span><i className="difference-orange" />橙色边带：尺寸范围不同（不编号）</span>
                <span>编号只对应画面内容变化</span>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
