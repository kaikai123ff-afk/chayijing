"use client";

/* Blob URLs and generated canvas previews are intentionally rendered locally. */
/* eslint-disable @next/next/no-img-element */

import {
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

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

type DiffStats = {
  width: number;
  height: number;
  changedPixels: number;
  exactChangedPixels: number;
  overlapPixels: number;
  outsidePixels: number;
  differenceRate: number;
  leftPreview: string;
  rightPreview: string;
  differencePreview: string;
};

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 6_000_000;
const MAX_IMAGE_EDGE = 6000;
const MAX_COMPARE_PIXELS = 6_000_000;
const MAX_PREVIEW_EDGE = 1400;
const MAX_PREVIEW_PIXELS = 2_000_000;
const ANALYSIS_STRIPE_HEIGHT = 192;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
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
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("无法读取此图片，请更换文件后重试");
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
    differenceData.data[previewOffset] = red;
    differenceData.data[previewOffset + 1] = green;
    differenceData.data[previewOffset + 2] = blue;
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
          const delta = Math.max(
            Math.abs(leftData.data[offset] - rightData.data[offset]),
            Math.abs(leftData.data[offset + 1] - rightData.data[offset + 1]),
            Math.abs(leftData.data[offset + 2] - rightData.data[offset + 2]),
            Math.abs(leftData.data[offset + 3] - rightData.data[offset + 3]),
          );
          if (delta > 0) exactChangedPixels += 1;
          if (delta > threshold) {
            changedPixels += 1;
            markDifference(
              x,
              canvasY,
              236,
              35,
              116,
              Math.min(245, 150 + delta),
            );
          }
        } else if (leftPresent || rightPresent) {
          outsidePixels += 1;
          markDifference(x, canvasY, 242, 148, 24, 205);
        }
      }
    }
  }

  differenceContext.putImageData(differenceData, 0, 0);
  return {
    width,
    height,
    changedPixels,
    exactChangedPixels,
    overlapPixels,
    outsidePixels,
    differenceRate:
      overlapPixels === 0 ? 0 : (changedPixels / overlapPixels) * 100,
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
  const [view, setView] = useState<ImageView>("slider");
  const [sliderPosition, setSliderPosition] = useState(50);
  const [sensitivity, setSensitivity] = useState<Sensitivity>("standard");
  const [alignment, setAlignment] = useState<Alignment>("top-left");
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [processing, setProcessing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
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
        if (!cancelled) setStats(result);
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
  const noDetectedContentDifference = Boolean(
    stats && stats.changedPixels === 0,
  );

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
                          ? "重叠区域一致，但图片尺寸不同"
                          : noDetectedContentDifference
                            ? "当前敏感度下未发现差异"
                            : "图片差异已标出"}
            </h2>
          </div>
          {stats ? (
            <div className={`match-status ${exactMatch ? "identical" : "changed"}`}>
              <span aria-hidden="true">{exactMatch ? "✓" : "!"}</span>
              {exactMatch
                ? "没有差异"
                : noDetectedContentDifference
                  ? "未检出明显差异"
                  : "发现差异"}
            </div>
          ) : null}
        </div>

        {leftAsset && rightAsset && stats ? (
          <>
            <div className="image-summary" aria-label="图片差异统计">
              <div className="image-stat">
                <strong>{formatNumber(stats.changedPixels)}</strong>
                <span>差异像素</span>
              </div>
              <div className="image-stat accent">
                <strong>{stats.differenceRate.toFixed(stats.differenceRate < 1 ? 2 : 1)}%</strong>
                <span>重叠区差异率</span>
              </div>
              <div className="image-stat">
                <strong>{formatNumber(stats.outsidePixels)}</strong>
                <span>尺寸外区域</span>
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
                图片尺寸不同，当前按原始像素{alignment === "top-left" ? "左上" : "居中"}对齐；橙色表示只有一侧存在的区域。
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
                {view === "difference" ? (
                  <div className="compact-control" aria-label="差异敏感度">
                    <span>敏感度</span>
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
                        {value === "low" ? "低" : value === "standard" ? "标准" : "高"}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

        <div className="image-result-stage" aria-live="polite">
          {!leftAsset || !rightAsset ? (
            <div className="empty-state">
              <span aria-hidden="true">▧</span>
              <strong>{!leftAsset && !rightAsset ? "上传两张图片开始对比" : "再上传另一张图片"}</strong>
              <p>图片只在当前浏览器中解码和分析，不会上传。</p>
            </div>
          ) : analysisError ? (
            <div className="empty-state compact">
              <span aria-hidden="true">!</span>
              <strong>图片分析失败</strong>
              <p>{analysisError}</p>
            </div>
          ) : processing || !stats ? (
            <div className="empty-state compact processing-state">
              <span aria-hidden="true">◌</span>
              <strong>正在本地分析图片</strong>
              <p>大尺寸图片可能需要几秒钟。</p>
            </div>
          ) : view === "side-by-side" ? (
            <div className="image-side-by-side">
              <figure>
                <figcaption>原始图片</figcaption>
                <div className="checkerboard"><img src={stats.leftPreview} alt={`原始图片：${leftAsset.name}`} /></div>
              </figure>
              <figure>
                <figcaption>新图片</figcaption>
                <div className="checkerboard"><img src={stats.rightPreview} alt={`新图片：${rightAsset.name}`} /></div>
              </figure>
            </div>
          ) : view === "slider" ? (
            <div className="image-slider-shell">
              <div className="image-slider-stage checkerboard" style={{ aspectRatio: `${stats.width} / ${stats.height}` }}>
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
              <div className="difference-stage checkerboard" style={{ aspectRatio: `${stats.width} / ${stats.height}` }}>
                <img className="difference-base" src={stats.rightPreview} alt={`新图片底图：${rightAsset.name}`} />
                <img className="difference-overlay" src={stats.differencePreview} alt="图片像素差异高亮图" />
              </div>
              <div className="difference-legend">
                <span><i className="difference-pink" />内容差异</span>
                <span><i className="difference-orange" />尺寸外区域</span>
                <span>敏感度会影响差异像素统计</span>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
