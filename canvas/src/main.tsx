import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Stage,
  Layer,
  Group,
  Image as KImage,
  Line,
  Arrow,
  Text,
  Rect,
  Transformer,
} from "react-konva";
import Konva from "konva";
import {
  History,
  id,
  localPoint,
  worldPoint,
  zoomAt,
  cropRect,
} from "./document";
import type { Asset, Document, Picture, Point, Mark } from "./document";
import { loadImage, exportPicture, download, regionCanvas } from "./export";
import { getGallery } from "./api";
import type { GalleryItem } from "./api";
import GenerationPanel from "./GenerationPanel";
import { EMPTY_GENERATION } from "./GenerationPanel";
import type { Job, GenerationState } from "./GenerationPanel";
import { useWorkspace } from "./useWorkspace";
import type { WorkspaceSnapshot } from "./workspaceStorage";
import ProjectControls from "./ProjectControls";
import type { ImageResult } from "./api";
import "./style.css";
import { ToolDock, ImageToolbar, tools } from "./CanvasTools";
import type { Tool } from "./CanvasTools";
function App() {
  const [doc, setDoc] = useState<Document>({ schemaVersion: 1, images: [] }),
    [assets, setAssets] = useState<Record<string, Asset>>({}),
    [selected, setSelected] = useState<string[]>([]);
  const [tool, setTool] = useState<Tool>("select"),
    [view, setView] = useState({ x: 40, y: 40, scale: 0.7 }),
    [size, setSize] = useState({ width: 900, height: 650 });
  const [color, setColor] = useState("#f87171"),
    [width, setWidth] = useState(12),
    [fontSize, setFontSize] = useState(36),
    [fontFamily, setFontFamily] = useState("sans-serif"),
    [text, setText] = useState("中文标注"),
    [notice, setNotice] = useState("导入图片后，选择工具开始编辑。"),
    [space, setSpace] = useState(false);
  const [gesture, setGesture] = useState<{
      imageId: string;
      points: number[];
      start: Point;
    } | null>(null),
    [revision, setRevision] = useState(0);
  const stage = useRef<Konva.Stage>(null),
    transformer = useRef<Konva.Transformer>(null),
    host = useRef<HTMLDivElement>(null),
    file = useRef<HTMLInputElement>(null),
    history = useRef(new History()),
    before = useRef<Document | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [generatorState, setGeneratorState] =
    useState<GenerationState>(EMPTY_GENERATION);
  const [generatorSeed, setGeneratorSeed] =
    useState<GenerationState>(EMPTY_GENERATION);
  const projectScope = useRef(0);
  const [gallery, setGallery] = useState<GalleryItem[] | null>(null),
    [galleryBusy, setGalleryBusy] = useState(false);
  const latest = useRef(doc);
  latest.current = doc;
  const [manipulating, setManipulating] = useState(false);
  const [referenceRequest, setReferenceRequest] = useState<string[] | null>(
    null,
  );
  const chooseTool = (key: Tool) => {
    setTool(key);
    setSelectedMark(null);
    setInspectorCollapsed(false);
    setGesture(null);
  };
  const [selectedMark, setSelectedMark] = useState<string | null>(null);
  const target = doc.images.find((i) => i.id === selected[0]),
    asset = target && assets[target.assetId];
  useEffect(() => setSelectedMark(null), [selected[0]]);
  const mark = target?.marks.find((m) => m.id === selectedMark);
  const regionTool = tool === "brush" || tool === "erase" || tool === "lasso";
  const activeToolName = tools.find(([key]) => key === tool)?.[1] || "选择";
  const savedState = useMemo<WorkspaceSnapshot>(
    () => ({
      schemaVersion: 1,
      document: doc,
      assets,
      view,
      history: {
        past: [...history.current.past],
        future: [...history.current.future],
      },
      selection: selected,
      generator: generatorState,
      tools: { tool, color, width, fontSize, fontFamily, text },
    }),
    [
      doc,
      assets,
      view,
      selected,
      generatorState,
      tool,
      color,
      width,
      fontSize,
      fontFamily,
      text,
      revision,
    ],
  );
  const workspace = useWorkspace(savedState, (snapshot) => {
    projectScope.current++;
    latest.current = snapshot.document;
    setDoc(snapshot.document);
    setAssets(snapshot.assets);
    setView(snapshot.view);
    setSelected(snapshot.selection);
    history.current.past = snapshot.history.past;
    history.current.future = snapshot.history.future;
    setGeneratorState(snapshot.generator);
    setGeneratorSeed(snapshot.generator);
    setJobs(snapshot.generator.jobs);
    setReferenceRequest(null);
    setManipulating(false);
    setGesture(null);
    setSelectedMark(null);
    setRevision((r) => r + 1);
    setTool(
      tools.some(([key]) => key === snapshot.tools.tool)
        ? (snapshot.tools.tool as Tool)
        : "select",
    );
    setColor(snapshot.tools.color);
    setWidth(snapshot.tools.width);
    setFontSize(snapshot.tools.fontSize);
    setFontFamily(snapshot.tools.fontFamily || "sans-serif");
    setText(snapshot.tools.text);
    setNotice("已恢复画布，可以继续编辑。");
  });
  const commit = (next: Document) => {
    history.current.commit(latest.current);
    latest.current = next;
    setDoc(next);
    setRevision((r) => r + 1);
  };
  const update = (fn: (d: Document) => void) => {
    const next = structuredClone(doc);
    fn(next);
    commit(next);
  };
  const patch = (p: Partial<Picture>) =>
    update((d) => {
      Object.assign(d.images.find((i) => i.id === target?.id)!, p);
    });
  const undo = () => {
    const next = history.current.undo(doc);
    if (next) setDoc(next);
    setRevision((r) => r + 1);
  };
  const redo = () => {
    const next = history.current.redo(doc);
    if (next) setDoc(next);
    setRevision((r) => r + 1);
  };
  const fit = (images = doc.images) => {
    const points = images.flatMap((i) => {
      const a = assets[i.assetId];
      if (!a) return [];
      const c = i.crop || { x: 0, y: 0, width: a.width, height: a.height };
      return [
        { x: c.x, y: c.y },
        { x: c.x + c.width, y: c.y },
        { x: c.x, y: c.y + c.height },
        { x: c.x + c.width, y: c.y + c.height },
      ].map((p) => worldPoint(p, i));
    });
    if (!points.length) {
      setView({ x: 40, y: 40, scale: 0.7 });
      return;
    }
    const x = Math.min(...points.map((p) => p.x)),
      y = Math.min(...points.map((p) => p.y)),
      w = Math.max(...points.map((p) => p.x)) - x,
      h = Math.max(...points.map((p) => p.y)) - y;
    const scale = Math.max(
      0.03,
      Math.min(2, (size.width - 100) / w, (size.height - 100) / h),
    );
    setView({
      x: (size.width - w * scale) / 2 - x * scale,
      y: (size.height - h * scale) / 2 - y * scale,
      scale,
    });
  };
  const importFiles = async (files: File[]) => {
    const scope = projectScope.current;
    const imported: Asset[] = [],
      pictures: Picture[] = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) continue;
      const url = URL.createObjectURL(f);
      try {
        const image = await loadImage(url);
        const a = {
          id: id(),
          url,
          width: image.width,
          height: image.height,
          name: f.name || "剪贴板图片",
        };
        imported.push(a);
        pictures.push({
          id: id(),
          assetId: a.id,
          x: (pictures.length + doc.images.length) * 100,
          y: (pictures.length + doc.images.length) * 60,
          scaleX: 1,
          scaleY: 1,
          rotation: 0,
          marks: [],
          regions: [],
        });
      } catch (e) {
        URL.revokeObjectURL(url);
        setNotice(String(e));
      }
    }
    if (scope !== projectScope.current) {
      for (const asset of imported) URL.revokeObjectURL(asset.url);
      return;
    }
    if (pictures.length) {
      setAssets((a) => ({
        ...a,
        ...Object.fromEntries(imported.map((a) => [a.id, a])),
      }));
      commit({
        ...latest.current,
        images: [...latest.current.images, ...pictures],
      });
      setSelected([pictures[0].id]);
      const s = Math.min(
        0.8,
        (size.width - 100) / imported[0].width,
        (size.height - 100) / imported[0].height,
      );
      setView({
        x: 50 - pictures[0].x * s,
        y: 50 - pictures[0].y * s,
        scale: s,
      });
      setNotice(`已导入 ${pictures.length} 张图片`);
    }
  };
  const addGenerated = async (job: Job, images: ImageResult[]) => {
    if (latest.current.images.some((p) => p.source?.jobId === job.id)) return;
    const scope = projectScope.current;
    const additions: Picture[] = [],
      newAssets: Asset[] = [];
    for (const [index, result] of images.entries()) {
      const url = result.base64
        ? "data:image/png;base64," + result.base64
        : result.url;
      if (!url) throw new Error("生成结果没有图片数据");
      const response = await fetch(url);
      if (!response.ok) throw new Error("生成结果下载失败");
      const blob = await response.blob(),
        assetUrl = URL.createObjectURL(blob);
      let loaded: HTMLImageElement;
      try {
        loaded = await loadImage(assetUrl);
      } catch (e) {
        URL.revokeObjectURL(assetUrl);
        throw e;
      }
      const a: Asset = {
        id: id(),
        url: assetUrl,
        width: loaded.width,
        height: loaded.height,
        name: "生成结果 " + (job.taskId || job.id) + " · " + (index + 1),
      };
      newAssets.push(a);
      const scale = Math.min(1, 600 / loaded.width, 600 / loaded.height);
      additions.push({
        id: id(),
        assetId: a.id,
        x: job.anchor.x + index * 680,
        y: job.anchor.y,
        scaleX: scale,
        scaleY: scale,
        rotation: 0,
        marks: [],
        regions: [],
        source: {
          jobId: job.id,
          taskId: job.taskId || "",
          parentIds: job.sourceIds,
        },
      });
    }
    if (scope !== projectScope.current) {
      for (const asset of newAssets) URL.revokeObjectURL(asset.url);
      throw new Error("已切换画布，请从来源画布查询该任务结果");
    }
    setAssets((previous) => ({
      ...previous,
      ...Object.fromEntries(newAssets.map((a) => [a.id, a])),
    }));
    commit({
      ...latest.current,
      images: [...latest.current.images, ...additions],
    });
    setNotice("生成结果已作为新图片插入，原图和后续编辑保留。");
  };
  const importUrl = async (url: string) => {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("图片获取失败，请重新选择");
      const blob = await response.blob();
      await importFiles([
        new File([blob], "插入图片.png", { type: blob.type }),
      ]);
    } catch (e) {
      setNotice(String(e));
    }
  };
  const showGallery = async () => {
    setGalleryBusy(true);
    try {
      const response = await getGallery();
      setGallery(response.items);
      setNotice(
        response.items.length
          ? "选择一张图库图片插入画布"
          : "图库还没有图片，请先导入或生成。",
      );
    } catch (e) {
      setNotice(String(e));
    } finally {
      setGalleryBusy(false);
    }
  };
  useEffect(() => {
    const message = async (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      if (e.data?.type === "canvas-import" && typeof e.data.url === "string") {
        await importUrl(e.data.url);
        window.parent.postMessage(
          { type: "canvas-imported", url: e.data.url },
          location.origin,
        );
      }
    };
    window.addEventListener("message", message);
    return () => window.removeEventListener("message", message);
  });
  useEffect(() => {
    if (window.parent !== window)
      window.parent.postMessage({ type: "canvas-ready" }, location.origin);
  }, []);
  const duplicate = () =>
    update((d) => {
      d.images.push(
        ...d.images
          .filter((i) => selected.includes(i.id))
          .map((i) => ({
            ...structuredClone(i),
            id: id(),
            x: i.x + 40,
            y: i.y + 40,
          })),
      );
    });
  const remove = () => {
    update((d) => {
      d.images = d.images.filter((i) => !selected.includes(i.id));
    });
    setSelected([]);
  };
  useEffect(() => {
    const el = host.current!;
    const observer = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const nodes = selected
      .map((i) => stage.current?.findOne("#image-" + i))
      .filter(Boolean) as Konva.Node[];
    transformer.current?.nodes(tool === "select" ? nodes : []);
  }, [selected, doc, tool]);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (
        (e.target instanceof Element &&
          e.target.closest("input,textarea,select,[contenteditable=true]")) ||
        e.isComposing
      )
        return;
      if (e.code === "Space") {
        e.preventDefault();
        setSpace(true);
      }
      if (e.key === "Escape") {
        setGesture(null);
        setTool("select");
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        remove();
      }
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === "z") {
          e.preventDefault();
          e.shiftKey ? redo() : undo();
        }
        if (e.key.toLowerCase() === "d") {
          e.preventDefault();
          duplicate();
        }
        if (e.key.toLowerCase() === "a") {
          e.preventDefault();
          setSelected(doc.images.map((i) => i.id));
        }
      }
    };
    const keyup = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpace(false);
    };
    const blur = () => setSpace(false);
    const paste = (e: ClipboardEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest("input,textarea,[contenteditable=true]")
      )
        return;
      const files = Array.from(e.clipboardData?.files || []);
      if (files.length) {
        e.preventDefault();
        void importFiles(files);
      }
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", blur);
      window.removeEventListener("paste", paste);
    };
  });
  const finishTransforms = () => {
    const next = structuredClone(latest.current);
    for (const i of next.images) {
      if (!selected.includes(i.id)) continue;
      const n = stage.current?.findOne("#image-" + i.id);
      if (n)
        Object.assign(i, {
          x: n.x(),
          y: n.y(),
          scaleX: n.scaleX(),
          scaleY: n.scaleY(),
          rotation: n.rotation(),
        });
    }
    history.current.commit(before.current || latest.current);
    before.current = null;
    latest.current = next;
    setDoc(next);
    setRevision((r) => r + 1);
  };
  const pointer = () => {
    const p = stage.current!.getPointerPosition()!;
    return { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale };
  };
  const start = (e: Konva.KonvaEventObject<PointerEvent>) => {
    if (space || tool === "pan") return;
    if (tool === "select") {
      if (e.target === stage.current) setSelected([]);
      return;
    }
    if (!target || !asset) {
      setNotice("请先选择一张目标图片");
      return;
    }
    const p = localPoint(pointer(), target);
    if (tool === "text") {
      if (!text.trim()) {
        setNotice("请先输入标注文字");
        return;
      }
      patch({
        marks: [
          ...target.marks,
          {
            id: id(),
            kind: "text",
            points: [p.x, p.y],
            color,
            width,
            text,
            fontSize,
            fontFamily,
          },
        ],
      });
      return;
    }
    setGesture({ imageId: target.id, points: [p.x, p.y, p.x, p.y], start: p });
  };
  const move = () => {
    if (!gesture || !target) return;
    const p = localPoint(pointer(), target);
    setGesture((g) =>
      g
        ? {
            ...g,
            points:
              tool === "arrow" || tool === "crop"
                ? [g.start.x, g.start.y, p.x, p.y]
                : [...g.points, p.x, p.y],
          }
        : null,
    );
  };
  const end = () => {
    if (!gesture || !target || !asset) return;
    const { points, start } = gesture;
    if (tool === "crop") {
      const crop = cropRect(
        start,
        { x: points[points.length - 2], y: points[points.length - 1] },
        asset,
      );
      if (crop.width >= 1 && crop.height >= 1) patch({ crop });
      else setNotice("裁剪区域过小，请重新拖动");
    } else if (tool === "pen" || tool === "arrow")
      patch({
        marks: [
          ...target.marks,
          { id: id(), kind: tool, points, color, width, fontSize },
        ],
      });
    else if (tool === "brush" || tool === "lasso" || tool === "erase")
      patch({
        regions: [...target.regions, { id: id(), kind: tool, points, width }],
      });
    setGesture(null);
  };
  async function save(kind: "original" | "reference" | "mask") {
    if (!target || !asset) return;
    try {
      download(
        await exportPicture(asset, target, kind),
        `${asset.name.replace(/\.[^.]+$/, "")}-${kind}.png`,
      );
      setNotice(`已导出 ${kind}，输出使用图片像素坐标`);
    } catch (e) {
      setNotice(String(e));
    }
  }
  return (
    <div className="workspace">
      <header>
        <strong>
          画布工作区 <span>预览</span>
        </strong>
        <div className="header-actions">
          <button
            className="panel-toggle"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            生成与工具
          </button>
          <ProjectControls workspace={workspace} />
          <button onClick={() => file.current?.click()}>导入图片</button>
          <button disabled={galleryBusy} onClick={() => void showGallery()}>
            {galleryBusy ? "加载图库…" : "从图库插入"}
          </button>
          <button onClick={() => fit()}>适配内容</button>
          <button disabled={!history.current.past.length} onClick={undo}>
            撤销
          </button>
          <button disabled={!history.current.future.length} onClick={redo}>
            重做
          </button>
          <output>{Math.round(view.scale * 100)}%</output>
        </div>
      </header>
      {!workspace.ready && (
        <div className="workspace-loading" role="status">
          <p>{workspace.status}</p>
          {workspace.error && (
            <>
              <p role="alert">{workspace.error}</p>
              <button onClick={() => void workspace.retryRestore()}>
                重试恢复
              </button>
            </>
          )}
        </div>
      )}
      <div className="mobile-note">
        窄屏可浏览与导入图片；完整编辑请使用桌面浏览器。
      </div>
      {gallery && (
        <section className="gallery-picker" aria-label="选择图库图片">
          <div>
            <strong>图库</strong>
            <button onClick={() => setGallery(null)}>关闭图库</button>
          </div>
          {gallery.length === 0 ? (
            <p>图库还没有图片。</p>
          ) : (
            gallery.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  void importUrl("/gallery/" + item.filename);
                  setGallery(null);
                }}
                title={item.prompt}
              >
                <img
                  src={
                    item.thumb_filename
                      ? "/gallery/thumb/" + item.thumb_filename
                      : "/gallery/" + item.filename
                  }
                  alt={item.prompt || "生成图片"}
                />
                <span>插入画布</span>
              </button>
            ))
          )}
        </section>
      )}
      <main>
        <div
          ref={host}
          className="stage-host"
          tabIndex={0}
          aria-label="图片画布，空格平移，滚轮缩放"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void importFiles(Array.from(e.dataTransfer.files));
          }}
          style={{
            cursor:
              space || tool === "pan"
                ? "grab"
                : tool === "select"
                  ? "default"
                  : "crosshair",
          }}
        >
          {!doc.images.length && (
            <div className="empty">
              <h1>从一张图片开始</h1>
              <p>拖入图片、粘贴截图，或选择本地文件。</p>
              <button onClick={() => file.current?.click()}>选择图片</button>
            </div>
          )}
          <Stage
            ref={stage}
            width={size.width}
            height={size.height}
            x={view.x}
            y={view.y}
            scaleX={view.scale}
            scaleY={view.scale}
            draggable={space || tool === "pan"}
            onDragStart={() => setManipulating(true)}
            onDragEnd={(e) => {
              setManipulating(false);
              if (e.target === stage.current)
                setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
            }}
            onWheel={(e) => {
              e.evt.preventDefault();
              setView((v) =>
                zoomAt(
                  v,
                  stage.current!.getPointerPosition()!,
                  v.scale * (e.evt.deltaY > 0 ? 1 / 1.12 : 1.12),
                ),
              );
            }}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerLeave={() => {
              if (gesture) end();
            }}
          >
            <Layer>
              {doc.images.map((image) => (
                <PictureNode
                  key={image.id}
                  picture={image}
                  asset={assets[image.assetId]}
                  active={selected.includes(image.id)}
                  movable={tool === "select" && !space}
                  select={(shift) =>
                    setSelected((s) =>
                      shift
                        ? s.includes(image.id)
                          ? s.filter((v) => v !== image.id)
                          : [...s, image.id]
                        : s.includes(image.id)
                          ? s
                          : [image.id],
                    )
                  }
                  begin={(node) => {
                    before.current = structuredClone(doc);
                    if (!selected.includes(image.id)) setSelected([image.id]);
                  }}
                  drag={(node) => {
                    const initial = before.current?.images.find(
                      (i) => i.id === image.id,
                    );
                    if (!initial || !selected.includes(image.id)) return;
                    const dx = node.x() - initial.x,
                      dy = node.y() - initial.y;
                    for (const i of before.current!.images) {
                      if (i.id === image.id || !selected.includes(i.id))
                        continue;
                      const n = stage.current?.findOne("#image-" + i.id);
                      if (n) n.position({ x: i.x + dx, y: i.y + dy });
                    }
                  }}
                  finish={(node) => {
                    const nodeIds = selected.includes(image.id)
                      ? selected
                      : [image.id];
                    const next = structuredClone(doc);
                    for (const i of next.images) {
                      if (!nodeIds.includes(i.id)) continue;
                      const n = stage.current?.findOne("#image-" + i.id);
                      if (n)
                        Object.assign(i, {
                          x: n.x(),
                          y: n.y(),
                          scaleX: n.scaleX(),
                          scaleY: n.scaleY(),
                          rotation: n.rotation(),
                        });
                    }
                    history.current.commit(before.current || doc);
                    before.current = null;
                    setDoc(next);
                    setRevision(revision + 1);
                  }}
                  draft={gesture?.imageId === image.id ? gesture : null}
                  tool={tool}
                  color={color}
                  width={width}
                />
              ))}
            </Layer>
            <Layer>
              {jobs
                .filter((j) => j.status !== "completed")
                .map((job) => (
                  <Group
                    key={job.id}
                    x={job.anchor.x}
                    y={job.anchor.y}
                    listening={false}
                  >
                    <Rect
                      width={600}
                      height={260}
                      fill="#1b1926"
                      stroke={
                        [
                          "failed",
                          "submit_error",
                          "query_error",
                          "fill_error",
                        ].includes(job.status)
                          ? "#f87171"
                          : "#8b79c6"
                      }
                      strokeWidth={2}
                      dash={[12, 6]}
                    />
                    <Text
                      x={24}
                      y={24}
                      width={550}
                      text={job.snapshot.prompt.slice(0, 80)}
                      fill="#eee"
                      fontSize={24}
                    />
                    <Text
                      x={24}
                      y={100}
                      width={550}
                      text={job.message}
                      fill="#c5b9e8"
                      fontSize={18}
                    />
                  </Group>
                ))}
              <Transformer
                ref={transformer}
                onTransformStart={() => {
                  setManipulating(true);
                  before.current = structuredClone(latest.current);
                }}
                onTransformEnd={() => {
                  setManipulating(false);
                  finishTransforms();
                }}
                flipEnabled={false}
                rotateEnabled
                keepRatio
                boundBoxFunc={(old, next) =>
                  Math.abs(next.width) < 10 || Math.abs(next.height) < 10
                    ? old
                    : next
                }
              />
            </Layer>
          </Stage>
          {selected.length > 0 && (
            <ImageToolbar
              pictures={doc.images.filter((p) => selected.includes(p.id))}
              assets={assets}
              view={view}
              size={size}
              hidden={manipulating || !!gesture || space || tool !== "select"}
              onTool={chooseTool}
              onReference={() => {
                setReferenceRequest([...selected]);
                setPanelOpen(true);
                setNotice(`已将 ${selected.length} 张图片设为生成参考。`);
              }}
              onCopy={duplicate}
              onExport={() => void save("reference")}
              onFocus={() =>
                fit(doc.images.filter((p) => selected.includes(p.id)))
              }
            />
          )}
          <div className="canvas-shortcuts" aria-hidden="true">
            滚轮缩放 · 空格平移 · Shift 多选
          </div>
          <ToolDock
            tool={tool}
            onTool={chooseTool}
            settings={{ color, width, fontFamily, fontSize, text }}
            onSettings={(next) => {
              if (next.color !== undefined) setColor(next.color);
              if (next.width !== undefined) setWidth(next.width);
              if (next.fontFamily !== undefined) setFontFamily(next.fontFamily);
              if (next.fontSize !== undefined) setFontSize(next.fontSize);
              if (next.text !== undefined) setText(next.text);
            }}
            editing={!!mark}
            onApply={() => {
              if (!target || !mark) return;
              patch({
                marks: target.marks.map((m) =>
                  m.id === mark.id
                    ? {
                        ...m,
                        color,
                        width,
                        fontSize,
                        ...(m.kind === "text" ? { text, fontFamily } : {}),
                      }
                    : m,
                ),
              });
            }}
            cropped={!!target?.crop}
            onRestoreCrop={() => patch({ crop: undefined })}
            hasRegions={!!target?.regions.length}
            onClearRegions={() => patch({ regions: [] })}
          />
        </div>
        <aside
          className={"right-sidebar" + (panelOpen ? " is-open" : "")}
          aria-label="工具与生成面板"
        >
          <section
            className={
              "tool-inspector" + (inspectorCollapsed ? " is-collapsed" : "")
            }
            aria-label="当前工具参数"
            data-tool={tool}
          >
            <div className="inspector-heading">
              <h2>{activeToolName}</h2>
              <button
                onClick={() => setInspectorCollapsed((v) => !v)}
                aria-expanded={!inspectorCollapsed}
              >
                {inspectorCollapsed ? "展开工具参数" : "收起工具参数"}
              </button>
            </div>
            {!inspectorCollapsed && (
              <div className="inspector-body">
                <label className="object-picker">
                  <span className="object-picker-label">当前图片</span>
                  <select
                    aria-label="当前图片"
                    value={target?.id || ""}
                    onChange={(e) => {
                      setSelected(e.target.value ? [e.target.value] : []);
                      setTool("select");
                    }}
                  >
                    <option value="">选择图片</option>
                    {doc.images.map((p) => (
                      <option key={p.id} value={p.id}>
                        {assets[p.assetId]?.name || "图片"}
                      </option>
                    ))}
                  </select>
                </label>
                {asset && (
                  <div className="object-summary">
                    <h3 title={asset.name}>{asset.name}</h3>
                    <span>
                      {asset.width} × {asset.height} px
                    </span>
                    <p>已选中 {selected.length} 张图片</p>
                  </div>
                )}
                {tool === "select" && (
                  <>
                    {" "}
                    {target && asset ? (
                      <>
                        <p>
                          {asset.width} × {asset.height} px · 原图
                        </p>
                        {target.source && (
                          <p>
                            来源任务 {target.source.taskId} ·{" "}
                            {target.source.parentIds.length} 张参考图
                          </p>
                        )}
                        <p>
                          <output aria-label="图片位置">
                            X {Math.round(target.x)} · Y {Math.round(target.y)}
                          </output>
                          <br />
                          <output aria-label="图片缩放">
                            缩放 {target.scaleX.toFixed(2)} ×{" "}
                            {target.scaleY.toFixed(2)}
                          </output>
                        </p>
                        <div className="pair">
                          <button onClick={duplicate}>复制</button>
                          <button onClick={remove}>删除图片</button>
                        </div>
                        <div className="pair">
                          <button
                            onClick={() =>
                              update((d) => {
                                const i = d.images.find(
                                  (i) => i.id === target.id,
                                )!;
                                d.images = d.images.filter(
                                  (v) => v.id !== i.id,
                                );
                                d.images.push(i);
                              })
                            }
                          >
                            移到顶层
                          </button>
                        </div>
                        <button
                          onClick={() =>
                            update((d) => {
                              const i = d.images.find(
                                (i) => i.id === target.id,
                              )!;
                              d.images = d.images.filter((v) => v.id !== i.id);
                              d.images.unshift(i);
                            })
                          }
                        >
                          移到底层
                        </button>
                        {window.parent !== window && (
                          <button
                            onClick={async () => {
                              try {
                                const c = await exportPicture(
                                  asset,
                                  target,
                                  "reference",
                                );
                                window.parent.postMessage(
                                  {
                                    type: "canvas-reference",
                                    url: c.toDataURL(),
                                  },
                                  location.origin,
                                );
                              } catch (e) {
                                setNotice(String(e));
                              }
                            }}
                          >
                            作为原界面参考图
                          </button>
                        )}
                        <label>
                          旋转角度
                          <input
                            key={target.id + target.rotation}
                            type="number"
                            aria-label="旋转角度"
                            defaultValue={Math.round(target.rotation)}
                            onBlur={(e) => {
                              const v = Number(e.target.value);
                              if (Number.isFinite(v) && v !== target.rotation)
                                patch({ rotation: v });
                            }}
                          />
                        </label>
                      </>
                    ) : (
                      <p>选中图片后可标注、裁剪和选择修改区域。</p>
                    )}
                  </>
                )}
                {tool === "pan" && (
                  <p>
                    拖动画布浏览内容。也可按住空格临时平移，滚轮围绕鼠标缩放。
                  </p>
                )}
                {tool === "crop" && (
                  <>
                    <p>在图片上拖动确定矩形范围。按 Esc 取消，原图始终保留。</p>
                  </>
                )}
                {regionTool && (
                  <p>
                    {tool === "lasso"
                      ? "沿目标区域描绘闭合轮廓，松开鼠标完成圈选。"
                      : tool === "erase"
                        ? "拖动擦除已选择的修改区域。"
                        : "拖动涂抹需要修改的区域。"}
                  </p>
                )}
                {target && (
                  <>
                    <h2>
                      标注 {target.marks.length} · 修改区域{" "}
                      {target.regions.length}
                    </h2>
                    {mark && (
                      <>
                        <p>在底部工具栏调整属性并应用到标注。</p>
                        <div className="pair">
                          {(["x", "y"] as const).map((axis, index) => (
                            <label key={mark.id + axis + mark.points[index]}>
                              标注 {axis.toUpperCase()}
                              <input
                                type="number"
                                defaultValue={Math.round(mark.points[index])}
                                onBlur={(e) => {
                                  const value = Number(e.target.value);
                                  if (!Number.isFinite(value)) return;
                                  const delta = value - mark.points[index];
                                  if (!delta) return;
                                  patch({
                                    marks: target.marks.map((m) =>
                                      m.id === mark.id
                                        ? {
                                            ...m,
                                            points: m.points.map((v, j) =>
                                              j % 2 === index ? v + delta : v,
                                            ),
                                          }
                                        : m,
                                    ),
                                  });
                                }}
                              />
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                    <div className="marks">
                      {target.marks.map((m) => (
                        <div key={m.id}>
                          <button
                            aria-label={"编辑标注 " + (m.text || m.kind)}
                            aria-pressed={selectedMark === m.id}
                            onClick={() => {
                              setTool(m.kind);
                              setSelectedMark(m.id);
                              setColor(m.color);
                              setWidth(m.width);
                              setFontSize(m.fontSize);
                              setFontFamily(m.fontFamily || "sans-serif");
                              if (m.text) setText(m.text);
                            }}
                          >
                            {m.kind === "text"
                              ? m.text
                              : m.kind === "arrow"
                                ? "箭头"
                                : "画笔"}
                          </button>
                          <button
                            aria-label="删除标注"
                            onClick={() =>
                              patch({
                                marks: target.marks.filter(
                                  (v) => v.id !== m.id,
                                ),
                              })
                            }
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </div>
                    <details className="export-options">
                      <summary>导出图片与蒙版</summary>
                      <div className="exports">
                        <button onClick={() => save("original")}>
                          原图 / 裁剪图
                        </button>
                        <button onClick={() => save("reference")}>
                          含标注参考图
                        </button>
                        <button onClick={() => save("mask")}>
                          独立 PNG mask
                        </button>
                      </div>
                    </details>
                  </>
                )}
              </div>
            )}
          </section>
          <GenerationPanel
            key={workspace.epoch}
            initialState={generatorSeed}
            onState={setGeneratorState}
            pictures={doc.images}
            assets={assets}
            selected={selected}
            referenceRequest={referenceRequest}
            onJobs={setJobs}
            onResult={addGenerated}
          />
        </aside>
      </main>
      <div className="status">
        <span className="status-message" role="status">
          {notice}
        </span>
        <span
          className="save-state"
          role="status"
          title={workspace.error || workspace.title}
        >
          {workspace.status}
        </span>
        {workspace.error && (
          <>
            <button onClick={() => void workspace.save().catch(() => {})}>
              重试保存
            </button>
            <button onClick={() => void workspace.create(true)}>
              另存为新画布
            </button>
            <span className="save-error" role="alert">
              {workspace.error}
            </span>
          </>
        )}
      </div>
      <input
        ref={file}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void importFiles(Array.from(e.target.files || []));
          e.target.value = "";
        }}
      />
    </div>
  );
}
function MarkNode({ mark: m }: { mark: Mark }) {
  return m.kind === "text" ? (
    <Text
      x={m.points[0]}
      y={m.points[1]}
      text={m.text}
      fill={m.color}
      fontSize={m.fontSize}
      fontFamily={m.fontFamily || "sans-serif"}
      listening={false}
    />
  ) : m.kind === "arrow" ? (
    <Arrow
      points={m.points}
      stroke={m.color}
      fill={m.color}
      strokeWidth={m.width}
      pointerLength={m.width * 3 + 8}
      pointerWidth={m.width * 3 + 8}
      listening={false}
    />
  ) : (
    <Line
      points={m.points}
      stroke={m.color}
      strokeWidth={m.width}
      lineCap="round"
      lineJoin="round"
      listening={false}
    />
  );
}
function PictureNode({
  picture: p,
  asset: a,
  active,
  movable,
  select,
  begin,
  drag,
  finish,
  draft,
  tool,
  color,
  width,
}: {
  picture: Picture;
  asset: Asset;
  active: boolean;
  movable: boolean;
  select: (shift: boolean) => void;
  begin: (node: Konva.Node) => void;
  drag: (node: Konva.Node) => void;
  finish: (node: Konva.Node) => void;
  draft: { points: number[]; start: Point } | null;
  tool: Tool;
  color: string;
  width: number;
}) {
  const [image, setImage] = useState<HTMLImageElement>(),
    [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    loadImage(a.url)
      .then((i) => {
        if (alive) setImage(i);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, [a.url]);
  const regions = React.useMemo(() => regionCanvas(a, p), [a, p.regions]);
  const crop = p.crop || { x: 0, y: 0, width: a.width, height: a.height };
  return (
    <Group
      ref={(node) => {
        if (node)
          node.getClientRect = (config = {}) =>
            config.skipTransform
              ? crop
              : node._transformedRect(crop, config.relativeTo);
      }}
      id={"image-" + p.id}
      x={p.x}
      y={p.y}
      scaleX={p.scaleX}
      scaleY={p.scaleY}
      rotation={p.rotation}
      draggable={movable}
      onClick={(e) => {
        if (movable) select(e.evt.shiftKey);
      }}
      onDragStart={(e) => begin(e.target)}
      onDragMove={(e) => drag(e.target)}
      onDragEnd={(e) => {
        e.cancelBubble = true;
        finish(e.target);
      }}
    >
      <Group
        clipX={crop.x}
        clipY={crop.y}
        clipWidth={crop.width}
        clipHeight={crop.height}
      >
        {image ? (
          <KImage image={image} width={a.width} height={a.height} />
        ) : (
          <>
            <Rect width={a.width} height={a.height} fill="#252535" />
            <Text
              text={error ? "图片加载失败，请重新导入" : "正在加载图片…"}
              fill="#fff"
              fontSize={32}
            />
          </>
        )}
        {p.marks.map((m) => (
          <MarkNode key={m.id} mark={m} />
        ))}
        <KImage image={regions} opacity={0.35} listening={false} />
        {draft &&
          tool !== "crop" &&
          (tool === "pen" || tool === "arrow" ? (
            <MarkNode
              mark={{
                id: "draft",
                kind: tool,
                points: draft.points,
                color,
                width,
                fontSize: 36,
              }}
            />
          ) : (
            <Line
              points={draft.points}
              stroke={tool === "erase" ? "#f87171" : "#a78bfa"}
              strokeWidth={width}
              closed={tool === "lasso"}
              fill={tool === "lasso" ? "#a78bfa66" : undefined}
              lineCap="round"
              listening={false}
            />
          ))}
      </Group>
      {active && (
        <Rect
          {...crop}
          stroke="#a78bfa"
          strokeWidth={2 / Math.max(p.scaleX, p.scaleY)}
          listening={false}
        />
      )}
      {draft && tool === "crop" && (
        <Rect
          {...cropRect(
            draft.start,
            { x: draft.points[2], y: draft.points[3] },
            a,
          )}
          stroke="#fff"
          strokeWidth={2}
          dash={[8, 8]}
          listening={false}
        />
      )}
    </Group>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
