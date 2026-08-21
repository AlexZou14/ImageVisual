"use client";

import {
  ChangeEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type DatasetItem = {
  id: string;
  name: string;
  relativePath: string;
  url: string;
};

type MethodResult = {
  id: string;
  name: string;
  folderName: string;
  handleKey?: string;
  visible: boolean;
  images: Record<string, string>;
  matched: number;
  totalFiles: number;
};

type Roi = { x: number; y: number; width: number; height: number; color?: string };
type ViewState = { zoom: number; panX: number; panY: number };
type Tool = "roi" | "pan";

type SavedConfig = {
  version: 1;
  datasetName: string;
  methods: Array<Pick<MethodResult, "id" | "name" | "folderName" | "handleKey" | "visible">>;
  currentIndex: number;
  roi: Roi;
  rois?: Roi[];
  activeRoiIndex?: number;
  detailZoom: number;
  gridColumns: number;
  originBoxColor?: string;
  originBoxLineWidth?: number;
};

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i;
const ROI_COLORS = [
  "#ff3b30",
  "#2f80ed",
  "#17a673",
  "#a855f7",
  "#f59e0b",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
];
const DEFAULT_ROI: Roi = {
  x: 0.16,
  y: 0.16,
  width: 0.3,
  height: 0.34,
  color: ROI_COLORS[0],
};
const DEFAULT_VIEW: ViewState = { zoom: 1, panX: 0, panY: 0 };
const DEFAULT_ORIGIN_BOX_LINE_WIDTH = 6;
const STORAGE_KEY = "imagevisual.project.v1";
const DB_NAME = "imagevisual-local";

function stripExtension(path: string) {
  return path.replace(/\.[^/.]+$/, "");
}

function fileName(path: string) {
  return path.split("/").pop() || path;
}

function normalizedStem(path: string) {
  return stripExtension(fileName(path))
    .replace(/(?:_result|_output|_enhanced|_restored)$/i, "")
    .toLowerCase();
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function safeFilePart(value: string) {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || "image";
}

function getRoiColor(roi: Roi, index: number) {
  return roi.color || ROI_COLORS[index % ROI_COLORS.length];
}

function comparisonOutputName(
  baseName: string,
  panelName: string,
  panelCount: number,
  suffix: string,
) {
  return panelCount === 1
    ? `${baseName}_${suffix}.png`
    : `${baseName}_${safeFilePart(panelName)}_${suffix}.png`;
}

async function cropImage(url: string, roi: Roi): Promise<Blob> {
  const image = new Image();
  image.src = url;
  await image.decode();

  const sx = Math.round(clamp(roi.x, 0, 1) * image.naturalWidth);
  const sy = Math.round(clamp(roi.y, 0, 1) * image.naturalHeight);
  const sourceWidth = Math.max(
    1,
    Math.min(
      image.naturalWidth - sx,
      Math.round(clamp(roi.width, 0.01, 1) * image.naturalWidth),
    ),
  );
  const sourceHeight = Math.max(
    1,
    Math.min(
      image.naturalHeight - sy,
      Math.round(clamp(roi.height, 0.01, 1) * image.naturalHeight),
    ),
  );
  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(
    image,
    sx,
    sy,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Unable to encode crop"))),
      "image/png",
    );
  });
}

async function annotateOriginalImage(
  url: string,
  rois: Roi[],
  requestedLineWidth: number,
): Promise<Blob> {
  const image = new Image();
  image.src = url;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable");
  context.drawImage(image, 0, 0);

  const lineWidth = clamp(
    Math.round(requestedLineWidth),
    1,
    Math.max(1, Math.min(image.naturalWidth, image.naturalHeight)),
  );
  const halfLine = lineWidth / 2;
  rois.forEach((roi, index) => {
    const color = getRoiColor(roi, index);
    const rawLeft = clamp(roi.x, 0, 1) * image.naturalWidth;
    const rawTop = clamp(roi.y, 0, 1) * image.naturalHeight;
    const rawRight = clamp(roi.x + roi.width, 0, 1) * image.naturalWidth;
    const rawBottom = clamp(roi.y + roi.height, 0, 1) * image.naturalHeight;
    const left = rawLeft <= 0 ? halfLine : rawLeft;
    const top = rawTop <= 0 ? halfLine : rawTop;
    const right = rawRight >= image.naturalWidth ? image.naturalWidth - halfLine : rawRight;
    const bottom = rawBottom >= image.naturalHeight ? image.naturalHeight - halfLine : rawBottom;

    context.save();
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    context.lineJoin = "miter";
    context.strokeRect(
      left,
      top,
      Math.max(1, right - left),
      Math.max(1, bottom - top),
    );
    context.restore();
  });

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Unable to encode annotation"))),
      "image/png",
    );
  });
}

async function writeBlobToDirectory(
  directory: FileSystemDirectoryHandle,
  name: string,
  blob: Blob,
) {
  const writableDirectory = directory as FileSystemDirectoryHandle & {
    getFileHandle: (
      fileName: string,
      options: { create: true },
    ) => Promise<
      FileSystemFileHandle & {
        createWritable: () => Promise<{
          write: (data: Blob) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }
    >;
  };
  const fileHandle = await writableDirectory.getFileHandle(name, { create: true });
  const writer = await fileHandle.createWritable();
  await writer.write(blob);
  await writer.close();
}

function downloadBlob(name: string, blob: Blob) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 1000);
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("handles")) {
        request.result.createObjectStore("handles");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveHandle(key: string, handle: FileSystemDirectoryHandle) {
  const db = await openHandleDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("handles", "readwrite");
    tx.objectStore("handles").put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function loadHandle(key: string): Promise<FileSystemDirectoryHandle | undefined> {
  const db = await openHandleDb();
  const value = await new Promise<FileSystemDirectoryHandle | undefined>((resolve, reject) => {
    const request = db.transaction("handles", "readonly").objectStore("handles").get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return value;
}

async function scanHandle(handle: FileSystemDirectoryHandle, prefix = "") {
  const files: Array<{ file: File; relativePath: string }> = [];
  const entries = (handle as FileSystemDirectoryHandle & {
    values: () => AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  }).values();
  for await (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "file" && IMAGE_EXTENSIONS.test(entry.name)) {
      files.push({ file: await entry.getFile(), relativePath });
    } else if (entry.kind === "directory") {
      files.push(...(await scanHandle(entry, relativePath)));
    }
  }
  return files;
}

function filesFromInput(list: FileList) {
  return Array.from(list)
    .filter((file) => IMAGE_EXTENSIONS.test(file.name))
    .map((file) => {
      const raw = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      const pieces = raw.split("/");
      return { file, relativePath: pieces.length > 1 ? pieces.slice(1).join("/") : raw };
    });
}

function buildDataset(files: Array<{ file: File; relativePath: string }>): DatasetItem[] {
  return files
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }))
    .map(({ file, relativePath }) => ({
      id: stripExtension(relativePath).toLowerCase(),
      name: file.name,
      relativePath,
      url: URL.createObjectURL(file),
    }));
}

function matchMethod(
  files: Array<{ file: File; relativePath: string }>,
  dataset: DatasetItem[],
) {
  const exact = new Map(dataset.map((item) => [item.id, item]));
  const stems = new Map<string, DatasetItem[]>();
  dataset.forEach((item) => {
    const stem = normalizedStem(item.relativePath);
    stems.set(stem, [...(stems.get(stem) || []), item]);
  });
  const images: Record<string, string> = {};
  files.forEach(({ file, relativePath }) => {
    const exactMatch = exact.get(stripExtension(relativePath).toLowerCase());
    const stemMatches = stems.get(normalizedStem(relativePath));
    const match = exactMatch || (stemMatches?.length === 1 ? stemMatches[0] : undefined);
    if (match && !images[match.id]) images[match.id] = URL.createObjectURL(file);
  });
  return { images, matched: Object.keys(images).length, totalFiles: files.length };
}

function Icon({ name }: { name: string }) {
  return <span className={`icon icon-${name}`} aria-hidden="true" />;
}

function CropPreview({ url, roi, zoom }: { url?: string; roi: Roi; zoom: number }) {
  const [size, setSize] = useState({ width: 1, height: 1 });
  if (!url) return <div className="detail-missing">此方法没有对应图片</div>;
  const cropWidth = Math.max(0.02, roi.width / zoom);
  const cropHeight = Math.max(0.02, roi.height / zoom);
  const cx = roi.x + roi.width / 2;
  const cy = roi.y + roi.height / 2;
  const x = clamp(cx - cropWidth / 2, 0, 1 - cropWidth);
  const y = clamp(cy - cropHeight / 2, 0, 1 - cropHeight);
  return (
    <div
      className="crop-preview"
      style={{ aspectRatio: `${cropWidth * size.width} / ${cropHeight * size.height}` }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt="选定区域放大预览"
        draggable={false}
        onLoad={(event) =>
          setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
        }
        style={{
          width: `${100 / cropWidth}%`,
          height: `${100 / cropHeight}%`,
          left: `${(-x / cropWidth) * 100}%`,
          top: `${(-y / cropHeight) * 100}%`,
        }}
      />
    </div>
  );
}

function ImageViewport({
  name,
  url,
  view,
  rois,
  activeRoiIndex,
  tool,
  onViewChange,
  onRoiChange,
  onActiveRoiChange,
}: {
  name: string;
  url?: string;
  view: ViewState;
  rois: Roi[];
  activeRoiIndex: number;
  tool: Tool;
  onViewChange: (view: ViewState) => void;
  onRoiChange: (index: number, roi: Roi) => void;
  onActiveRoiChange: (index: number) => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | {
        mode: "draw" | "move" | "resize" | "pan";
        roiIndex: number;
        handle?: string;
        startPoint: { x: number; y: number };
        startClient: { x: number; y: number };
        startRoi: Roi;
        startView: ViewState;
      }
    | undefined
  >(undefined);
  const [natural, setNatural] = useState({ width: 1, height: 1 });
  const [frame, setFrame] = useState({ width: 1, height: 1 });

  useEffect(() => {
    if (!frameRef.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setFrame({ width: entry.contentRect.width, height: entry.contentRect.height }),
    );
    observer.observe(frameRef.current);
    return () => observer.disconnect();
  }, []);

  const imageRect = useMemo(() => {
    const imageRatio = natural.width / natural.height;
    const frameRatio = frame.width / frame.height;
    if (imageRatio > frameRatio) {
      const width = frame.width;
      return { width, height: width / imageRatio, left: 0, top: (frame.height - width / imageRatio) / 2 };
    }
    const height = frame.height;
    return { width: height * imageRatio, height, left: (frame.width - height * imageRatio) / 2, top: 0 };
  }, [frame, natural]);

  const toImagePoint = useCallback(
    (clientX: number, clientY: number) => {
      const bounds = frameRef.current?.getBoundingClientRect();
      if (!bounds) return { x: 0, y: 0 };
      const screenX = clientX - bounds.left;
      const screenY = clientY - bounds.top;
      const layerX = (screenX - imageRect.left - view.panX * frame.width - imageRect.width / 2) / view.zoom + imageRect.width / 2;
      const layerY = (screenY - imageRect.top - view.panY * frame.height - imageRect.height / 2) / view.zoom + imageRect.height / 2;
      return {
        x: clamp(layerX / imageRect.width, 0, 1),
        y: clamp(layerY / imageRect.height, 0, 1),
      };
    },
    [frame, imageRect, view],
  );

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!url) return;
    const target = event.target as HTMLElement;
    const action = target.closest<HTMLElement>("[data-roi-action]")?.dataset.roiAction;
    const handle = target.closest<HTMLElement>("[data-roi-handle]")?.dataset.roiHandle;
    const targetRoiIndex = Number(
      target.closest<HTMLElement>("[data-roi-index]")?.dataset.roiIndex,
    );
    const interactionRoiIndex = Number.isInteger(targetRoiIndex)
      ? targetRoiIndex
      : activeRoiIndex;
    const interactionRoi = rois[interactionRoiIndex] || rois[activeRoiIndex];
    if (!interactionRoi) return;
    const point = toImagePoint(event.clientX, event.clientY);
    let mode: "draw" | "move" | "resize" | "pan" = tool === "pan" ? "pan" : "draw";
    if (tool === "roi" && handle) mode = "resize";
    else if (tool === "roi" && action === "move") mode = "move";
    if (mode !== "pan" && interactionRoiIndex !== activeRoiIndex) {
      onActiveRoiChange(interactionRoiIndex);
    }
    dragRef.current = {
      mode,
      roiIndex: interactionRoiIndex,
      handle,
      startPoint: point,
      startClient: { x: event.clientX, y: event.clientY },
      startRoi: { ...interactionRoi },
      startView: { ...view },
    };
    if (mode === "draw") {
      onRoiChange(interactionRoiIndex, {
        x: point.x,
        y: point.y,
        width: 0.01,
        height: 0.01,
        color: interactionRoi.color,
      });
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "pan") {
      onViewChange({
        ...drag.startView,
        panX: drag.startView.panX + (event.clientX - drag.startClient.x) / frame.width,
        panY: drag.startView.panY + (event.clientY - drag.startClient.y) / frame.height,
      });
      return;
    }
    const point = toImagePoint(event.clientX, event.clientY);
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;
    if (drag.mode === "draw") {
      onRoiChange(drag.roiIndex, {
        x: Math.min(drag.startPoint.x, point.x),
        y: Math.min(drag.startPoint.y, point.y),
        width: Math.max(0.01, Math.abs(point.x - drag.startPoint.x)),
        height: Math.max(0.01, Math.abs(point.y - drag.startPoint.y)),
        color: drag.startRoi.color,
      });
    } else if (drag.mode === "move") {
      onRoiChange(drag.roiIndex, {
        ...drag.startRoi,
        x: clamp(drag.startRoi.x + dx, 0, 1 - drag.startRoi.width),
        y: clamp(drag.startRoi.y + dy, 0, 1 - drag.startRoi.height),
      });
    } else {
      let left = drag.startRoi.x;
      let top = drag.startRoi.y;
      let right = drag.startRoi.x + drag.startRoi.width;
      let bottom = drag.startRoi.y + drag.startRoi.height;
      if (drag.handle?.includes("w")) left = clamp(drag.startRoi.x + dx, 0, right - 0.02);
      if (drag.handle?.includes("e")) right = clamp(right + dx, left + 0.02, 1);
      if (drag.handle?.includes("n")) top = clamp(drag.startRoi.y + dy, 0, bottom - 0.02);
      if (drag.handle?.includes("s")) bottom = clamp(bottom + dy, top + 0.02, 1);
      onRoiChange(drag.roiIndex, {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
        color: drag.startRoi.color,
      });
    }
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!url) return;
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.12 : 0.89;
    onViewChange({ ...view, zoom: clamp(view.zoom * factor, 1, 8) });
  };

  return (
    <article className="viewport-card">
      <div className="viewport-title">
        <span>{name}</span>
        <span>{Math.round(view.zoom * 100)}%</span>
      </div>
      <div
        ref={frameRef}
        className={`image-frame tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (dragRef.current = undefined)}
        onPointerCancel={() => (dragRef.current = undefined)}
        onWheel={onWheel}
      >
        {url ? (
          <div
            className="image-layer"
            style={{
              width: imageRect.width,
              height: imageRect.height,
              left: imageRect.left,
              top: imageRect.top,
              transform: `translate(${view.panX * frame.width}px, ${view.panY * frame.height}px) scale(${view.zoom})`,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={`${name} 当前结果`}
              draggable={false}
              onLoad={(event) =>
                setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
              }
            />
            {rois.map((roi, index) => {
              const active = index === activeRoiIndex;
              return (
                <div
                  className={`roi-box ${active ? "is-active" : "is-inactive"}`}
                  data-roi-action="move"
                  data-roi-index={index}
                  key={index}
                  style={{
                    left: `${roi.x * 100}%`,
                    top: `${roi.y * 100}%`,
                    width: `${roi.width * 100}%`,
                    height: `${roi.height * 100}%`,
                    zIndex: active ? 2 : 1,
                    "--roi-color": getRoiColor(roi, index),
                  } as React.CSSProperties}
                >
                  <span className="roi-label">ROI {index + 1}</span>
                  {active &&
                    (["nw", "ne", "sw", "se"] as const).map((handle) => (
                      <button
                        type="button"
                        aria-label={`调整选区 ${index + 1} ${handle}`}
                        className={`roi-handle handle-${handle}`}
                        data-roi-handle={handle}
                        data-roi-index={index}
                        key={handle}
                      />
                    ))}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="missing-image">
            <Icon name="image" />
            <span>未匹配到当前图片</span>
          </div>
        )}
      </div>
    </article>
  );
}

export default function Home() {
  const datasetInputRef = useRef<HTMLInputElement>(null);
  const methodInputRef = useRef<HTMLInputElement>(null);
  const [dataset, setDataset] = useState<DatasetItem[]>([]);
  const [datasetName, setDatasetName] = useState("");
  const [methods, setMethods] = useState<MethodResult[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [rois, setRois] = useState<Roi[]>([{ ...DEFAULT_ROI }]);
  const [activeRoiIndex, setActiveRoiIndex] = useState(0);
  const [detailZoom, setDetailZoom] = useState(1);
  const [tool, setTool] = useState<Tool>("roi");
  const [gridColumns, setGridColumns] = useState(2);
  const [syncView, setSyncView] = useState(true);
  const [sharedView, setSharedView] = useState<ViewState>(DEFAULT_VIEW);
  const [localViews, setLocalViews] = useState<Record<string, ViewState>>({});
  const [toast, setToast] = useState("");
  const [savedConfig, setSavedConfig] = useState<SavedConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [cropBusy, setCropBusy] = useState(false);
  const [originExportBusy, setOriginExportBusy] = useState(false);
  const [originBoxLineWidth, setOriginBoxLineWidth] = useState(
    DEFAULT_ORIGIN_BOX_LINE_WIDTH,
  );

  const currentItem = dataset[currentIndex];
  const visibleMethods = methods.filter((method) => method.visible);
  const panels = currentItem
    ? [
        { id: "dataset", name: datasetName || "Dataset", url: currentItem.url },
        ...visibleMethods.map((method) => ({
          id: method.id,
          name: method.name,
          url: method.images[currentItem.id],
        })),
      ]
    : [];

  const roi = rois[activeRoiIndex] || rois[0] || DEFAULT_ROI;
  const updateRoiAtIndex = (index: number, nextRoi: Roi) => {
    setRois((current) =>
      current.map((region, regionIndex) => (regionIndex === index ? nextRoi : region)),
    );
  };
  const setRoi = (update: Roi | ((current: Roi) => Roi)) => {
    setRois((current) =>
      current.map((region, regionIndex) => {
        if (regionIndex !== activeRoiIndex) return region;
        return typeof update === "function" ? update(region) : update;
      }),
    );
  };

  const activeConfig = useMemo<SavedConfig>(
    () => ({
      version: 1,
      datasetName,
      methods: methods.map(({ id, name, folderName, handleKey, visible }) => ({
        id,
        name,
        folderName,
        handleKey,
        visible,
      })),
      currentIndex,
      roi,
      rois,
      activeRoiIndex,
      detailZoom,
      gridColumns,
      originBoxColor: getRoiColor(roi, activeRoiIndex),
      originBoxLineWidth,
    }),
    [
      datasetName,
      methods,
      currentIndex,
      roi,
      rois,
      activeRoiIndex,
      detailZoom,
      gridColumns,
      originBoxLineWidth,
    ],
  );

  useEffect(() => {
    let active = true;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SavedConfig;
        queueMicrotask(() => {
          if (active) setSavedConfig(parsed);
        });
      }
    } catch {
      // Ignore invalid local configuration.
    }
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!dataset.length) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(activeConfig));
  }, [dataset.length, activeConfig]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!dataset.length || (event.target as HTMLElement)?.matches("input, textarea")) return;
      if (event.key === "ArrowRight") setCurrentIndex((value) => Math.min(dataset.length - 1, value + 1));
      if (event.key === "ArrowLeft") setCurrentIndex((value) => Math.max(0, value - 1));
      if (event.key === "0") setSharedView(DEFAULT_VIEW);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dataset.length]);

  const pickDirectory = async () => {
    const picker = (window as typeof window & {
      showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    return picker ? picker() : undefined;
  };

  const applyDatasetFiles = async (
    files: Array<{ file: File; relativePath: string }>,
    name: string,
    handle?: FileSystemDirectoryHandle,
  ) => {
    if (!files.length) {
      setToast("所选文件夹中没有支持的图片");
      return [];
    }
    const items = buildDataset(files);
    setDataset(items);
    setDatasetName(name);
    setMethods([]);
    setCurrentIndex(0);
    setRois([{ ...DEFAULT_ROI }]);
    setActiveRoiIndex(0);
    setSharedView(DEFAULT_VIEW);
    setLocalViews({});
    if (handle) await saveHandle("dataset", handle);
    setToast(`已载入 ${items.length} 张数据集图片`);
    return items;
  };

  const chooseDataset = async () => {
    setBusy(true);
    try {
      const handle = await pickDirectory();
      if (!handle) return datasetInputRef.current?.click();
      await applyDatasetFiles(await scanHandle(handle), handle.name, handle);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") setToast("读取数据集失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const buildMethod = (
    files: Array<{ file: File; relativePath: string }>,
    folderName: string,
    items = dataset,
    saved?: SavedConfig["methods"][number],
  ): MethodResult => {
    const matched = matchMethod(files, items);
    return {
      id: saved?.id || crypto.randomUUID(),
      name: saved?.name || folderName,
      folderName,
      handleKey: saved?.handleKey,
      visible: saved?.visible ?? true,
      ...matched,
    };
  };

  const chooseMethod = async () => {
    if (!dataset.length) return setToast("请先选择数据集");
    setBusy(true);
    try {
      const handle = await pickDirectory();
      if (!handle) return methodInputRef.current?.click();
      const handleKey = `method-${crypto.randomUUID()}`;
      const method = buildMethod(await scanHandle(handle), handle.name);
      method.handleKey = handleKey;
      await saveHandle(handleKey, handle);
      setMethods((value) => [...value, method]);
      setToast(`${method.name} 已匹配 ${method.matched}/${dataset.length} 张`);
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") setToast("读取方法文件夹失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const restoreProject = async () => {
    if (!savedConfig) return;
    setBusy(true);
    try {
      const datasetHandle = await loadHandle("dataset");
      if (!datasetHandle) throw new Error("missing handle");
      const permission = await (datasetHandle as FileSystemDirectoryHandle & {
        requestPermission: (options: { mode: "read" }) => Promise<PermissionState>;
      }).requestPermission({ mode: "read" });
      if (permission !== "granted") throw new Error("permission denied");
      const items = buildDataset(await scanHandle(datasetHandle));
      const restoredMethods: MethodResult[] = [];
      for (const meta of savedConfig.methods) {
        if (!meta.handleKey) continue;
        const handle = await loadHandle(meta.handleKey);
        if (!handle) continue;
        const state = await (handle as FileSystemDirectoryHandle & {
          requestPermission: (options: { mode: "read" }) => Promise<PermissionState>;
        }).requestPermission({ mode: "read" });
        if (state === "granted") {
          restoredMethods.push(buildMethod(await scanHandle(handle), handle.name, items, meta));
        }
      }
      setDataset(items);
      setDatasetName(savedConfig.datasetName || datasetHandle.name);
      setMethods(restoredMethods);
      setCurrentIndex(clamp(savedConfig.currentIndex, 0, Math.max(0, items.length - 1)));
      const restoredRois = savedConfig.rois?.length
        ? savedConfig.rois
        : [savedConfig.roi || DEFAULT_ROI];
      const coloredRois = restoredRois.map((region, index) => ({
        ...region,
        color:
          region.color ||
          (index === 0 && savedConfig.originBoxColor
            ? savedConfig.originBoxColor
            : ROI_COLORS[index % ROI_COLORS.length]),
      }));
      setRois(coloredRois);
      setActiveRoiIndex(
        clamp(savedConfig.activeRoiIndex || 0, 0, coloredRois.length - 1),
      );
      setDetailZoom(savedConfig.detailZoom || 1);
      setGridColumns(savedConfig.gridColumns || 2);
      setOriginBoxLineWidth(
        savedConfig.originBoxLineWidth || DEFAULT_ORIGIN_BOX_LINE_WIDTH,
      );
      setToast(`项目已恢复，共 ${restoredMethods.length} 个方法`);
    } catch {
      setToast("无法自动恢复，请重新选择数据集文件夹");
    } finally {
      setBusy(false);
    }
  };

  const onDatasetInput = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files?.length) return;
    const rawPath = (event.target.files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    await applyDatasetFiles(filesFromInput(event.target.files), rawPath?.split("/")[0] || "Dataset");
    event.target.value = "";
  };

  const onMethodInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files?.length) return;
    const rawPath = (event.target.files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
    const folderName = rawPath?.split("/")[0] || `Method ${methods.length + 1}`;
    const method = buildMethod(filesFromInput(event.target.files), folderName);
    setMethods((value) => [...value, method]);
    setToast(`${method.name} 已匹配 ${method.matched}/${dataset.length} 张`);
    event.target.value = "";
  };

  const updateMethod = (id: string, patch: Partial<MethodResult>) =>
    setMethods((value) => value.map((method) => (method.id === id ? { ...method, ...patch } : method)));

  const moveMethod = (index: number, direction: -1 | 1) => {
    setMethods((value) => {
      const target = index + direction;
      if (target < 0 || target >= value.length) return value;
      const next = [...value];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const addRoi = () => {
    const offset = 0.04 + (rois.length % 4) * 0.025;
    const newRoi: Roi = {
      x: clamp(roi.x + offset, 0, 1 - roi.width),
      y: clamp(roi.y + offset, 0, 1 - roi.height),
      width: roi.width,
      height: roi.height,
      color: ROI_COLORS[rois.length % ROI_COLORS.length],
    };
    setRois((current) => [...current, newRoi]);
    setActiveRoiIndex(rois.length);
  };

  const deleteActiveRoi = () => {
    if (rois.length === 1) {
      setToast("至少需要保留一个选区");
      return;
    }
    const nextLength = rois.length - 1;
    setRois((current) => current.filter((_, index) => index !== activeRoiIndex));
    setActiveRoiIndex(Math.min(activeRoiIndex, nextLength - 1));
  };

  const exportConfig = () => {
    if (!dataset.length) return;
    const blob = new Blob([JSON.stringify(activeConfig, null, 2)], { type: "application/json" });
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${datasetName || "imagevisual"}.imagevisual.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  };

  const exportCrops = async () => {
    if (!currentItem) return;
    const availablePanels = panels.filter(
      (panel): panel is typeof panel & { url: string } => Boolean(panel.url),
    );
    if (!availablePanels.length) return setToast("当前图片没有可裁剪的内容");

    setCropBusy(true);
    try {
      const pickerAvailable = Boolean(
        (window as typeof window & { showDirectoryPicker?: unknown }).showDirectoryPicker,
      );
      const targetDirectory = pickerAvailable ? await pickDirectory() : undefined;
      if (pickerAvailable && !targetDirectory) return;

      const baseName = safeFilePart(stripExtension(currentItem.name));
      const crops = await Promise.all(
        availablePanels.flatMap((panel) =>
          rois.map(async (region, regionIndex) => ({
            name: comparisonOutputName(
              baseName,
              panel.name,
              availablePanels.length,
              `crop${regionIndex + 1}`,
            ),
            blob: await cropImage(panel.url, region),
          })),
        ),
      );

      if (targetDirectory) {
        for (const crop of crops) {
          await writeBlobToDirectory(targetDirectory, crop.name, crop.blob);
        }
        setToast(`已将 ${crops.length} 张裁剪图片保存到所选文件夹`);
      } else {
        crops.forEach((crop) => downloadBlob(crop.name, crop.blob));
        setToast(`已生成 ${crops.length} 张裁剪图片`);
      }
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") {
        setToast("裁剪保存失败，请检查图片格式和文件夹权限");
      }
    } finally {
      setCropBusy(false);
    }
  };

  const exportAnnotatedComparisons = async () => {
    if (!currentItem) return;
    const availablePanels = panels.filter(
      (panel): panel is typeof panel & { url: string } => Boolean(panel.url),
    );
    if (!availablePanels.length) return setToast("当前比较组没有可保存的图片");

    setOriginExportBusy(true);
    try {
      const pickerAvailable = Boolean(
        (window as typeof window & { showDirectoryPicker?: unknown }).showDirectoryPicker,
      );
      const targetDirectory = pickerAvailable ? await pickDirectory() : undefined;
      if (pickerAvailable && !targetDirectory) return;

      const baseName = safeFilePart(stripExtension(currentItem.name));
      const annotatedImages = await Promise.all(
        availablePanels.map(async (panel) => ({
          name: comparisonOutputName(
            baseName,
            panel.name,
            availablePanels.length,
            "origin",
          ),
          blob: await annotateOriginalImage(
            panel.url,
            rois,
            originBoxLineWidth,
          ),
        })),
      );

      if (targetDirectory) {
        for (const image of annotatedImages) {
          await writeBlobToDirectory(targetDirectory, image.name, image.blob);
        }
        setToast(`已保存 ${annotatedImages.length} 张带选定框的比较图`);
      } else {
        annotatedImages.forEach((image) => downloadBlob(image.name, image.blob));
        setToast(`已生成 ${annotatedImages.length} 张带选定框的比较图`);
      }
    } catch (error) {
      if ((error as DOMException).name !== "AbortError") {
        setToast("原图标注保存失败，请检查图片格式和文件夹权限");
      }
    } finally {
      setOriginExportBusy(false);
    }
  };

  const resetView = () => {
    setSharedView(DEFAULT_VIEW);
    setLocalViews({});
  };

  const setPanelView = (id: string, view: ViewState) => {
    if (syncView) setSharedView(view);
    else setLocalViews((values) => ({ ...values, [id]: view }));
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark"><Icon name="crop" /></span>
          <div>
            <strong>ImageVisual</strong>
            <span>多方法图像细节对比</span>
          </div>
        </div>
        <div className="top-actions">
          {dataset.length > 0 && (
            <button type="button" className="button secondary" onClick={exportConfig}>
              <Icon name="download" /> 导出配置
            </button>
          )}
          <button type="button" className="button primary" onClick={chooseDataset} disabled={busy}>
            <Icon name="folder" /> {dataset.length ? "更换数据集" : "选择数据集"}
          </button>
        </div>
      </header>

      <input ref={datasetInputRef} className="hidden-input" type="file" multiple onChange={onDatasetInput} {...({ webkitdirectory: "" } as object)} />
      <input ref={methodInputRef} className="hidden-input" type="file" multiple onChange={onMethodInput} {...({ webkitdirectory: "" } as object)} />

      {!dataset.length ? (
        <section className="welcome">
          <div className="welcome-art" aria-hidden="true">
            <div className="mock-image one"><span /></div>
            <div className="mock-image two"><span /></div>
            <div className="mock-roi" />
          </div>
          <p className="eyebrow">LOCAL IMAGE COMPARISON</p>
          <h1>从一个数据集开始，逐步加入每一种方法</h1>
          <p className="welcome-copy">
            图片只在本机浏览器中处理。选择数据集建立索引，随后添加任意数量的方法文件夹，并在同一选区中检查细节差异。
          </p>
          <div className="welcome-actions">
            <button type="button" className="button primary large" onClick={chooseDataset} disabled={busy}>
              <Icon name="folder" /> {busy ? "正在读取…" : "选择数据集文件夹"}
            </button>
            {savedConfig && (
              <button type="button" className="button secondary large" onClick={restoreProject} disabled={busy}>
                恢复上次项目
              </button>
            )}
          </div>
          <div className="welcome-steps">
            <span><b>01</b> 选择数据集</span>
            <i />
            <span><b>02</b> 添加方法</span>
            <i />
            <span><b>03</b> 调节 ROI</span>
          </div>
        </section>
      ) : (
        <div className="workspace">
          <aside className="sidebar">
            <div className="sidebar-section">
              <p className="section-label">数据集</p>
              <div className="dataset-card">
                <span className="dataset-icon"><Icon name="database" /></span>
                <div>
                  <strong>{datasetName}</strong>
                  <span>{dataset.length} 张图片</span>
                </div>
              </div>
            </div>

            <div className="sidebar-section methods-section">
              <div className="section-heading">
                <p className="section-label">方法</p>
                <span>{methods.length}</span>
              </div>
              <div className="method-list">
                {methods.map((method, index) => (
                  <div className={`method-row ${method.visible ? "" : "is-hidden"}`} key={method.id}>
                    <span className="drag-dots" aria-hidden="true">⠿</span>
                    <div className="method-info">
                      <input
                        value={method.name}
                        aria-label="方法名称"
                        onChange={(event) => updateMethod(method.id, { name: event.target.value })}
                      />
                      <span className={method.matched === dataset.length ? "complete" : "partial"}>
                        {method.matched}/{dataset.length} 已匹配
                      </span>
                    </div>
                    <div className="method-actions">
                      <button type="button" aria-label="上移" disabled={index === 0} onClick={() => moveMethod(index, -1)}>↑</button>
                      <button type="button" aria-label="下移" disabled={index === methods.length - 1} onClick={() => moveMethod(index, 1)}>↓</button>
                      <button type="button" aria-label={method.visible ? "隐藏" : "显示"} onClick={() => updateMethod(method.id, { visible: !method.visible })}>
                        <Icon name={method.visible ? "eye" : "eye-off"} />
                      </button>
                      <button type="button" aria-label="删除" onClick={() => setMethods((value) => value.filter((item) => item.id !== method.id))}>
                        <Icon name="trash" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button type="button" className="add-method" onClick={chooseMethod} disabled={busy}>
                <span>＋</span>
                <div><strong>添加方法文件夹</strong><small>自动按文件名匹配</small></div>
              </button>
            </div>

            <div className="sidebar-note">
              <Icon name="lock" />
              <span>所有图片仅在本机处理，不会上传。</span>
            </div>
          </aside>

          <section className="viewer">
            <div className="viewer-toolbar">
              <div className="image-navigation">
                <button type="button" aria-label="上一张" disabled={currentIndex === 0} onClick={() => setCurrentIndex((value) => value - 1)}>‹</button>
                <div>
                  <strong>{currentItem?.relativePath}</strong>
                  <span>{currentIndex + 1} / {dataset.length}</span>
                </div>
                <button type="button" aria-label="下一张" disabled={currentIndex === dataset.length - 1} onClick={() => setCurrentIndex((value) => value + 1)}>›</button>
              </div>
              <div className="viewer-controls">
                <div className="segmented" aria-label="操作工具">
                  <button type="button" className={tool === "roi" ? "active" : ""} onClick={() => setTool("roi")}><Icon name="crop" /> 选区</button>
                  <button type="button" className={tool === "pan" ? "active" : ""} onClick={() => setTool("pan")}><Icon name="hand" /> 拖动</button>
                </div>
                <label className="switch-label">
                  <input type="checkbox" checked={syncView} onChange={(event) => setSyncView(event.target.checked)} />
                  <span /> 同步视图
                </label>
                <button type="button" className="toolbar-button" onClick={resetView}>适应窗口</button>
                <select value={gridColumns} aria-label="网格列数" onChange={(event) => setGridColumns(Number(event.target.value))}>
                  <option value={1}>1 列</option>
                  <option value={2}>2 列</option>
                  <option value={3}>3 列</option>
                  <option value={4}>4 列</option>
                </select>
              </div>
            </div>

            <div className="comparison-scroll">
              <div className="comparison-grid" style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(240px, 1fr))` }}>
                {panels.map((panel) => (
                  <ImageViewport
                    key={panel.id}
                    name={panel.name}
                    url={panel.url}
                    rois={rois}
                    activeRoiIndex={activeRoiIndex}
                    tool={tool}
                    view={syncView ? sharedView : localViews[panel.id] || sharedView}
                    onViewChange={(view) => setPanelView(panel.id, view)}
                    onRoiChange={updateRoiAtIndex}
                    onActiveRoiChange={setActiveRoiIndex}
                  />
                ))}
              </div>
            </div>

            <div className="filmstrip" aria-label="数据集图片列表">
              {dataset.map((item, index) => (
                <button
                  type="button"
                  key={item.id}
                  className={index === currentIndex ? "active" : ""}
                  onClick={() => setCurrentIndex(index)}
                  aria-label={`查看 ${item.relativePath}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={item.url} alt="" loading="lazy" />
                  <span>{index + 1}</span>
                </button>
              ))}
            </div>
          </section>

          <aside className="detail-panel">
            <div className="detail-header">
              <div>
                <p className="section-label">细节对比</p>
                <span>{rois.length} 个共享选区 · 实时更新</span>
              </div>
              <div className="detail-header-actions">
                <span className="live-dot">LIVE</span>
                <button
                  type="button"
                  className="crop-save-button"
                  onClick={exportCrops}
                  disabled={cropBusy}
                >
                  <Icon name="download" /> {cropBusy ? "正在裁剪…" : "保存全部裁剪"}
                </button>
              </div>
            </div>

            <div className="zoom-control">
              <div><label htmlFor="detail-zoom">细节放大</label><strong>{detailZoom}×</strong></div>
              <input id="detail-zoom" type="range" min="1" max="4" step="0.5" value={detailZoom} onChange={(event) => setDetailZoom(Number(event.target.value))} />
            </div>

            <div className="roi-manager">
              <div className="roi-manager-heading">
                <strong>选区管理</strong>
                <span>当前：选区 {activeRoiIndex + 1}</span>
              </div>
              <div className="roi-tabs" aria-label="选择需要编辑的选区">
                {rois.map((_, index) => (
                  <button
                    type="button"
                    className={index === activeRoiIndex ? "active" : ""}
                    aria-pressed={index === activeRoiIndex}
                    onClick={() => setActiveRoiIndex(index)}
                    key={index}
                  >
                    <span
                      className="roi-color-dot"
                      style={{ backgroundColor: getRoiColor(rois[index], index) }}
                      aria-hidden="true"
                    />
                    选区 {index + 1}
                  </button>
                ))}
              </div>
              <div className="roi-manager-actions">
                <button type="button" onClick={addRoi}>＋ 添加选区</button>
                <button
                  type="button"
                  className="delete"
                  onClick={deleteActiveRoi}
                  disabled={rois.length === 1}
                >
                  删除当前
                </button>
              </div>
            </div>

            <div className="roi-fields">
              {(["x", "y", "width", "height"] as const).map((field) => (
                <label key={field}>
                  <span>{{ x: "X", y: "Y", width: "宽", height: "高" }[field]}</span>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={Math.round(roi[field] * 100)}
                    onChange={(event) => {
                      const value = clamp(Number(event.target.value) / 100, field === "width" || field === "height" ? 0.02 : 0, 1);
                      setRoi((current) => ({ ...current, [field]: value }));
                    }}
                  />
                  <small>%</small>
                </label>
              ))}
            </div>

            <section className="origin-export-panel" aria-labelledby="origin-export-title">
              <div className="origin-export-heading">
                <div>
                  <strong id="origin-export-title">比较图选定框</strong>
                  <span>
                    当前 {panels.filter((panel) => panel.url).length} 张、{rois.length} 个编号选区
                  </span>
                </div>
                <span className="origin-file-name">
                  *_origin.png
                </span>
              </div>
              <div className="origin-style-controls">
                <label className="origin-color-control">
                  <span>当前选区颜色</span>
                  <div>
                    <input
                      type="color"
                      value={getRoiColor(roi, activeRoiIndex)}
                      onChange={(event) =>
                        setRoi((current) => ({ ...current, color: event.target.value }))
                      }
                      aria-label={`选区 ${activeRoiIndex + 1} 的颜色`}
                    />
                    <code>{getRoiColor(roi, activeRoiIndex).toUpperCase()}</code>
                  </div>
                </label>
                <label className="origin-width-control">
                  <span>线条粗细 <b>{originBoxLineWidth}px</b></span>
                  <input
                    type="range"
                    min="1"
                    max="32"
                    step="1"
                    value={originBoxLineWidth}
                    onChange={(event) => setOriginBoxLineWidth(Number(event.target.value))}
                  />
                </label>
              </div>
              <div className="origin-line-preview" aria-label="选定框线条预览">
                <span
                  style={{
                    borderTopColor: getRoiColor(roi, activeRoiIndex),
                    borderTopWidth: Math.min(originBoxLineWidth, 12),
                  }}
                />
              </div>
              <button
                type="button"
                className="origin-save-button"
                onClick={exportAnnotatedComparisons}
                disabled={originExportBusy}
              >
                <Icon name="download" />
                {originExportBusy ? "正在生成…" : "保存全部带选定框的比较图"}
              </button>
            </section>

            <div className="detail-list">
              {panels.map((panel) => (
                <article className="detail-item" key={panel.id}>
                  <div><strong>{panel.name}</strong><span>{panel.url ? "已匹配" : "缺失"}</span></div>
                  <CropPreview url={panel.url} roi={roi} zoom={detailZoom} />
                </article>
              ))}
            </div>
          </aside>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
      {busy && <div className="busy-bar" />}
    </main>
  );
}
