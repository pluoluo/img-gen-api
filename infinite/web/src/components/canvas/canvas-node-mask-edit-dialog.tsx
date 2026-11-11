import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Input, Modal, Progress, Slider, Tooltip, theme as antdTheme } from "antd";
import { Brush, Eraser, ImagePlus, Redo2, RotateCcw, Undo2, LoaderCircle, Contrast, Scan, Plus, Minus, WandSparkles, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readImageMeta } from "@/lib/image-utils";
import { useSmartMask } from "@/components/canvas/use-smart-mask";
import type { BinaryMask } from "@/lib/smart-mask";
import { useImageEditorViewport } from "@/components/canvas/use-image-editor-viewport";

export type CanvasImageMaskEditPayload = {
    prompt: string;
    maskDataUrl: string;
    apiMaskDataUrl: string;
    generate: boolean;
};

type DrawMode = "paint" | "erase";
type Point = { x: number; y: number };
type MaskStroke = { mode: DrawMode; size: number; points: Point[] };
type MaskAction = MaskStroke | { mode: DrawMode; region: BinaryMask };
type BrushPreview = { x: number; y: number; size: number; adjusting: boolean };

const defaultBrushSize = 100;
const maskOverlayColor = "#2563eb";
const maskOverlayAlpha = 0.4;

export function CanvasNodeMaskEditDialog({ dataUrl, open, onClose, onConfirm }: { dataUrl: string; open: boolean; onClose: () => void; onConfirm: (payload: CanvasImageMaskEditPayload) => void }) {
    const { t } = useTranslation();
    const { token } = antdTheme.useToken();
    const smart = useSmartMask(dataUrl, open);
    const smartCanvasRef = useRef<HTMLCanvasElement>(null);
    const [pointLabel, setPointLabel] = useState<0 | 1>(1);
    const maskCanvasRef = useRef<HTMLCanvasElement>(null);
    const previewCanvasRef = useRef<HTMLCanvasElement>(null);
    const imageRef = useRef<HTMLImageElement>(null);
    const drawingRef = useRef<{ active: boolean; stroke: MaskStroke | null }>({ active: false, stroke: null });
    const brushAdjustRef = useRef<{ active: boolean; pointerId: number; startX: number; startSize: number; previewX: number; previewY: number } | null>(null);
    const historyRef = useRef<MaskAction[]>([]);
    const redoRef = useRef<MaskAction[]>([]);
    const [image, setImage] = useState<{ width: number; height: number } | null>(null);
    const [prompt, setPrompt] = useState("");
    const [brushSize, setBrushSize] = useState(defaultBrushSize);
    const [mode, setMode] = useState<DrawMode | "smart">("paint");
    const [error, setError] = useState("");
    const [historySize, setHistorySize] = useState(0);
    const [redoSize, setRedoSize] = useState(0);
    const [brushPreview, setBrushPreview] = useState<BrushPreview | null>(null);
    const viewport = useImageEditorViewport(image, open);

    useEffect(() => {
        if (!open) return;
        setPrompt("");
        setBrushSize(defaultBrushSize);
        setMode("paint");
        setError("");
        setHistorySize(0);
        setRedoSize(0);
        setBrushPreview(null);
        historyRef.current = [];
        redoRef.current = [];
        setPointLabel(1);
        brushAdjustRef.current = null;
        drawingRef.current = { active: false, stroke: null };
        void readImageMeta(dataUrl).then(setImage);
    }, [dataUrl, open]);

    useEffect(() => {
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
    }, [image]);

    useEffect(() => {
        const canvas = smartCanvasRef.current;
        clearCanvas(canvas);
        const context = canvas?.getContext("2d");
        if (context && smart.selection) drawBinaryMask(context, smart.selection, maskOverlayColor);
    }, [smart.selection, image]);

    const changeMode = (next: DrawMode | "smart") => {
        setMode(next); setBrushPreview(null);
        if (next === "smart") {
            if (smart.state.stage === "idle") smart.prepare();
        } else {
            smart.clear();
            if (smart.busy) smart.stop();
        }
    };
    const applySelection = (operation: DrawMode) => {
        if (!smart.selection || smart.busy) return;
        historyRef.current.push({ mode: operation, region: smart.selection });
        redoRef.current = [];
        setHistorySize(historyRef.current.length); setRedoSize(0);
        replayMask(historyRef.current, maskCanvasRef.current, previewCanvasRef.current);
        smart.clear(); setPointLabel(1); setError("");
    };

    const draw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
        const maskCanvas = maskCanvasRef.current;
        const context = maskCanvas?.getContext("2d", { willReadFrequently: true });
        const previewContext = previewCanvasRef.current?.getContext("2d");
        const stroke = drawingRef.current.stroke;
        if (!maskCanvas || !context || !previewContext || !stroke) return;
        configureStrokeContext(context, stroke);
        configurePreviewStrokeContext(previewContext, stroke);
        const last = stroke.points.at(-1);
        drawMaskStroke(context, last || point, point, stroke.size);
        drawMaskStroke(previewContext, last || point, point, stroke.size);
        stroke.points.push(point);
        if (stroke.mode === "paint") {
            setError("");
        }
    };

    const updateBrushPreview = (event: ReactPointerEvent<HTMLCanvasElement>, size = brushSize, adjusting = false) => {
        if (mode === "smart") return;
        setBrushPreview({
            x: event.clientX,
            y: event.clientY,
            size,
            adjusting,
        });
    };

    const startDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (mode === "smart") {
            if (event.button !== 0 && event.button !== 2) return;
            event.preventDefault(); event.stopPropagation();
            const point = readCanvasPoint(event.currentTarget, event.clientX, event.clientY);
            smart.predict({ x: Math.max(0, Math.min(1, point.x / event.currentTarget.width)), y: Math.max(0, Math.min(1, point.y / event.currentTarget.height)), label: event.button === 2 ? 0 : pointLabel });
            return;
        }
        if ((event.button === 0 || event.button === 2) && event.altKey) {
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            brushAdjustRef.current = {
                active: true,
                pointerId: event.pointerId,
                startX: event.clientX,
                startSize: brushSize,
                previewX: event.clientX,
                previewY: event.clientY,
            };
            updateBrushPreview(event, brushSize, true);
            return;
        }
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        updateBrushPreview(event);
        drawingRef.current = { active: true, stroke: { mode, size: brushSize, points: [] } };
        draw(event);
    };

    const moveDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const brushAdjust = brushAdjustRef.current;
        if (brushAdjust?.active && event.pointerId === brushAdjust.pointerId) {
            event.preventDefault();
            event.stopPropagation();
            const nextSize = clampBrushSize(brushAdjust.startSize + event.clientX - brushAdjust.startX);
            setBrushSize(nextSize);
            setBrushPreview({
                x: brushAdjust.previewX,
                y: brushAdjust.previewY,
                size: nextSize,
                adjusting: true,
            });
            return;
        }
        updateBrushPreview(event);
        if (!drawingRef.current.active) return;
        event.preventDefault();
        draw(event);
    };

    const stopDraw = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const brushAdjust = brushAdjustRef.current;
        if (brushAdjust?.active && event.pointerId === brushAdjust.pointerId) {
            brushAdjustRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
            updateBrushPreview(event, brushSize);
            return;
        }
        const stroke = drawingRef.current.stroke;
        drawingRef.current = { active: false, stroke: null };
        if (stroke?.points.length) {
            historyRef.current.push(stroke);
            setHistorySize(historyRef.current.length);
            redoRef.current = [];
            setRedoSize(0);
        }
    };

    const undoMask = useCallback(() => {
        if (smart.points.length) { smart.undoPoint(); return; }
        if (smart.busy) return;
        if (drawingRef.current.active || !historyRef.current.length) return;
        const stroke = historyRef.current.pop();
        if (stroke) redoRef.current.push(stroke);
        setHistorySize(historyRef.current.length);
        setRedoSize(redoRef.current.length);
        replayMask(historyRef.current, maskCanvasRef.current, previewCanvasRef.current);
        setError("");
    }, [smart.busy, smart.points.length, smart.undoPoint]);

    const redoMask = useCallback(() => {
        if (smart.busy || smart.selection) return;
        if (drawingRef.current.active || !redoRef.current.length) return;
        const stroke = redoRef.current.pop();
        if (stroke) historyRef.current.push(stroke);
        setHistorySize(historyRef.current.length);
        setRedoSize(redoRef.current.length);
        replayMask(historyRef.current, maskCanvasRef.current, previewCanvasRef.current);
        setError("");
    }, [smart.busy, smart.selection]);

    const resetMask = () => {
        historyRef.current = [];
        redoRef.current = [];
        setHistorySize(0);
        setRedoSize(0);
        clearCanvas(maskCanvasRef.current);
        clearCanvas(previewCanvasRef.current);
        smart.clear(); setPointLabel(1);
        setError("");
    };

    useEffect(() => {
        if (!open) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("input,textarea,[contenteditable='true']")) return;
            const key = event.key.toLowerCase();
            const modifier = (event.metaKey || event.ctrlKey) && !event.altKey;
            const isUndo = modifier && !event.shiftKey && key === "z";
            const isRedo = modifier && ((event.shiftKey && key === "z") || (!event.shiftKey && key === "y"));
            if (!isUndo && !isRedo) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            if (isRedo) redoMask();
            else undoMask();
        };
        window.addEventListener("keydown", handleKeyDown, true);
        return () => window.removeEventListener("keydown", handleKeyDown, true);
    }, [open, redoMask, undoMask]);

    const submit = (generate: boolean) => {
        const nextPrompt = prompt.trim();
        const canvas = maskCanvasRef.current;
        const element = imageRef.current;
        if (generate && !nextPrompt) return setError(t("canvas.editors.maskPromptRequired"));
        if (!canvas || !element) return;
        if (!canvasHasPaint(canvas)) return setError(t("canvas.editors.maskRequired"));
        const apiMask = document.createElement("canvas");
        apiMask.width = canvas.width;
        apiMask.height = canvas.height;
        const context = apiMask.getContext("2d")!;
        context.fillStyle = "white";
        context.fillRect(0, 0, apiMask.width, apiMask.height);
        context.globalCompositeOperation = "destination-out";
        context.drawImage(canvas, 0, 0);
        onConfirm({ prompt: nextPrompt, maskDataUrl: buildMaskOverlay(element, canvas), apiMaskDataUrl: apiMask.toDataURL("image/png"), generate });
    };

    const stageKeys = { idle: "smartHint", loading: "smartLoading", compiling: "smartCompiling", preprocessing: "smartPreprocessing", encoding: "smartEncoding", selecting: "smartSelecting", rendering: "smartRendering", ready: "smartHint", error: "smartError" } as const;
    const stageText = t(`canvas.editors.${stageKeys[smart.state.stage]}`, { progress: smart.state.stage === "loading" && smart.state.progress !== undefined ? `${Math.round(smart.state.progress)}%` : "" });
    const elapsedText = t("canvas.editors.smartElapsed", { seconds: smart.elapsed });

    return (
        <Modal title={null} open={open && Boolean(dataUrl)} onCancel={onClose} footer={null} width={980} centered destroyOnHidden transitionName="" maskTransitionName="">
            <div className="grid gap-5 lg:grid-cols-[minmax(360px,1fr)_320px]" data-canvas-no-zoom>
                <div
                    ref={viewport.viewportRef}
                    {...viewport.panHandlers}
                    className={`relative h-[min(44vh,420px)] min-h-[240px] rounded-xl border border-black/10 bg-transparent dark:border-white/10 lg:h-[min(68vh,720px)] lg:min-h-[360px] ${viewport.scrollClassName} ${viewport.isPanning ? "cursor-grabbing" : viewport.spacePressed ? "cursor-grab" : ""}`}
                >
                    <div className="relative" style={viewport.contentStyle}>
                        <div ref={viewport.stageRef} className="absolute isolate overflow-hidden rounded-lg bg-transparent select-none [backface-visibility:hidden] [contain:layout_paint] [transform:translateZ(0)]" style={viewport.stageStyle}>
                            {image ? (
                                <>
                                    <canvas ref={maskCanvasRef} width={image.width} height={image.height} className="hidden" />
                                    <div className="absolute left-0 top-0 [backface-visibility:hidden]" style={viewport.mediaStyle}>
                                        <img ref={imageRef} src={dataUrl} alt="" className="absolute inset-0 block h-full w-full bg-transparent object-contain" draggable={false} />
                                        <canvas
                                            ref={previewCanvasRef}
                                            width={image.width}
                                            height={image.height}
                                            className={`absolute inset-0 h-full w-full touch-none ${mode === "smart" ? "cursor-crosshair" : "cursor-none"}`}
                                            aria-label={t("canvas.editors.maskCanvas")}
                                            style={{ opacity: maskOverlayAlpha }}
                                            onPointerDown={startDraw}
                                            onPointerMove={moveDraw}
                                            onPointerUp={stopDraw}
                                            onPointerCancel={stopDraw}
                                            onPointerEnter={(event) => updateBrushPreview(event)}
                                            onPointerLeave={() => {
                                                if (!drawingRef.current.active && !brushAdjustRef.current?.active) setBrushPreview(null);
                                            }}
                                            onContextMenu={(event) => event.preventDefault()}
                                        />
                                        <canvas ref={smartCanvasRef} hidden={mode !== "smart"} width={image.width} height={image.height} className="pointer-events-none absolute inset-0 h-full w-full" style={{ opacity: maskOverlayAlpha }} />
                                        {mode === "smart" ? smart.points.map((point, index) => (
                                            <span key={index} className="pointer-events-none absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2" style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%`, color: point.label ? token.colorSuccess : token.colorError, background: token.colorBgElevated, borderColor: "currentColor" }}>
                                                {point.label ? <Plus className="size-3" /> : <Minus className="size-3" />}
                                            </span>
                                        )) : null}
                                    </div>
                                </>
                            ) : null}
                        </div>
                    </div>
                    {mode === "smart" && smart.busy ? <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: token.colorBgElevated, color: token.colorText }} aria-hidden="true">
                        <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
                        <span className="min-w-0 flex-1">{stageText}</span><span className="shrink-0 tabular-nums">{elapsedText}</span>
                    </div> : null}
                </div>
                {brushPreview
                    ? createPortal(
                          <div
                              className={`pointer-events-none fixed z-[1100] rounded-full border-2 ${brushPreview.adjusting ? "border-[#fbbf24] bg-black/10" : "border-white/90 bg-black/5"} shadow-[0_0_0_1px_rgba(0,0,0,.8)]`}
                              style={{ left: brushPreview.x, top: brushPreview.y, width: Math.max(4, brushPreview.size * viewport.imageScale), aspectRatio: 1, transform: "translate(-50%, -50%)" }}
                          >
                              {brushPreview.adjusting ? <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-black/75 px-1.5 py-0.5 text-xs font-semibold text-white">{brushSize}px</span> : null}
                          </div>,
                          document.body,
                      )
                    : null}

                <div className="flex min-h-[360px] flex-col gap-5">
                    <div>
                        <h2 className="text-xl font-semibold">{t("canvas.editors.maskTitle")}</h2>
                        <div className="mt-2 text-sm opacity-60">{image ? `${image.width} x ${image.height}px` : t("canvas.editors.loading")}</div>
                        <div className="mt-2 text-xs leading-5 opacity-55">{t("canvas.editors.maskHint")}</div>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                        <Button type={mode === "smart" ? "primary" : "text"} aria-pressed={mode === "smart"} icon={<Scan className="size-4" />} onClick={() => changeMode("smart")}>
                            {t("canvas.editors.smartSelect")}
                        </Button>
                        <Button type={mode === "paint" ? "primary" : "text"} aria-pressed={mode === "paint"} icon={<Brush className="size-4" />} onClick={() => changeMode("paint")}>
                            {t("canvas.editors.brush")}
                        </Button>
                        <Button type={mode === "erase" ? "primary" : "text"} aria-pressed={mode === "erase"} icon={<Eraser className="size-4" />} onClick={() => changeMode("erase")}>
                            {t("canvas.editors.erase")}
                        </Button>
                    </div>

                    {mode === "smart" ? (
                        <div className="space-y-2" aria-busy={smart.busy} data-smart-mask-stage={smart.state.stage} data-smart-mask-backend={smart.state.backend}>
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex gap-1">
                                    <Button type={pointLabel === 1 ? "primary" : "text"} aria-pressed={pointLabel === 1} size="small" icon={<Plus className="size-3" />} onClick={() => setPointLabel(1)}>{t("canvas.editors.smartInclude")}</Button>
                                    <Button type={pointLabel === 0 ? "primary" : "text"} aria-pressed={pointLabel === 0} size="small" icon={<Minus className="size-3" />} disabled={!smart.points.length} onClick={() => setPointLabel(0)}>{t("canvas.editors.smartExclude")}</Button>
                                </div>
                                {smart.state.backend ? <span className="text-xs opacity-70">{smart.state.backend === "webgpu" ? "GPU" : "CPU"}</span> : null}
                            </div>
                            <div className="text-xs font-medium">SAM 2.1 Tiny</div>
                            <div className="flex items-start gap-2 text-xs leading-5" role="status" aria-live="polite">
                                {smart.busy ? <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" /> : null}
                                <span className="flex-1">{stageText}</span>
                            </div>
                            {smart.busy ? <div className="text-xs tabular-nums" style={{ color: token.colorTextSecondary }}>{elapsedText}</div> : null}
                            {smart.state.stage === "loading" && smart.state.progress !== undefined ? <Progress percent={Math.round(smart.state.progress)} showInfo={false} size="small" aria-label={t("canvas.editors.smartDownloadProgress")} /> : null}
                            {smart.busy && smart.points.length ? <div className="text-xs" style={{ color: token.colorTextSecondary }}>{t("canvas.editors.smartQueued", { count: smart.points.length })}</div> : null}
                            {smart.state.error === "includeFirst" ? <div className="text-xs" style={{ color: token.colorWarningText }}>{t("canvas.editors.smartIncludeFirst")}</div> : null}
                            {smart.candidates.length > 1 ? <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t("canvas.editors.smartCandidates")}>
                                <span className="mr-1 text-xs">{t("canvas.editors.smartCandidates")}</span>
                                {smart.candidates.map((candidate, index) => <Button key={candidate.index} size="small" type={smart.selected === candidate.index ? "primary" : "text"} aria-pressed={smart.selected === candidate.index} disabled={smart.busy} onClick={() => smart.chooseCandidate(candidate.index)}>{t("canvas.editors.smartCandidate", { index: index + 1 })}</Button>)}
                            </div> : null}
                            {smart.candidates.find(candidate => candidate.index === smart.selected)?.misses ? <div className="text-xs leading-5" style={{ color: token.colorWarningText }}>{t("canvas.editors.smartConflict")}</div> : null}
                            {smart.state.stage === "error" ? <div className="space-y-1">
                                <details className="text-xs break-words" style={{ color: token.colorError }}><summary>{t("canvas.editors.smartErrorDetails")}</summary>{smart.state.error}</details>
                                <Button size="small" onClick={() => smart.prepare(true)}>{t("canvas.editors.smartCpuRetry")}</Button>
                            </div> : null}
                            <div className="flex flex-wrap gap-1">
                                <Button type="text" size="small" icon={<Contrast className="size-3" />} disabled={!smart.selection || smart.busy} onClick={smart.invert}>{t("canvas.editors.smartInvert")}</Button>
                                <Button size="small" disabled={!smart.selection || smart.busy} onClick={() => applySelection("paint")}>{t("canvas.editors.smartAdd")}</Button>
                                <Button size="small" disabled={!smart.selection || smart.busy} onClick={() => applySelection("erase")}>{t("canvas.editors.smartSubtract")}</Button>
                                <Button type="text" size="small" disabled={!smart.points.length} onClick={smart.undoPoint}>{t("canvas.editors.smartUndoPoint")}</Button>
                                <Button type="text" size="small" disabled={!smart.points.length} onClick={() => { smart.clear(); setPointLabel(1); }}>{t("canvas.editors.smartClear")}</Button>
                                {smart.state.backend === "webgpu" && smart.state.stage !== "error" ? <Button type="text" size="small" onClick={() => smart.prepare(true)}>{t("canvas.editors.smartUseCpu")}</Button> : null}
                                {smart.busy ? <Button type="text" size="small" onClick={smart.stop}>{t("canvas.editors.smartStop")}</Button> : null}
                                {smart.state.stage === "idle" ? <Button size="small" onClick={() => smart.prepare()}>{t("canvas.editors.smartStart")}</Button> : null}
                            </div>
                            {smart.selection ? <div className="text-xs opacity-70">{t("canvas.editors.smartPending")}</div> : null}
                        </div>
                    ) : null}

                    <div className="flex items-center justify-between rounded-lg border border-black/10 px-2 py-1 dark:border-white/10">
                        <Tooltip title={t("canvas.editors.undoMaskTitle")}>
                            <Button type="text" icon={<Undo2 className="size-4" />} disabled={!smart.points.length && (!historySize || smart.busy)} aria-label={t("canvas.editors.undoMask")} onClick={undoMask} />
                        </Tooltip>
                        <Tooltip title={t("canvas.editors.redoMaskTitle")}>
                            <Button type="text" icon={<Redo2 className="size-4" />} disabled={!redoSize || smart.busy || Boolean(smart.selection)} aria-label={t("canvas.editors.redoMask")} onClick={redoMask} />
                        </Tooltip>
                        <div className="flex items-center gap-1">
                            <Tooltip title={t("canvas.editors.zoomOut")}>
                                <Button type="text" icon={<ZoomOut className="size-4" />} disabled={!viewport.canZoomOut} aria-label={t("canvas.editors.zoomOut")} onClick={viewport.zoomOut} />
                            </Tooltip>
                            <button type="button" className="min-w-14 text-center text-xs font-semibold tabular-nums opacity-70" onClick={viewport.resetZoom}>
                                {Math.round(viewport.zoom * 100)}%
                            </button>
                            <Tooltip title={t("canvas.editors.zoomIn")}>
                                <Button type="text" icon={<ZoomIn className="size-4" />} disabled={!viewport.canZoomIn} aria-label={t("canvas.editors.zoomIn")} onClick={viewport.zoomIn} />
                            </Tooltip>
                        </div>
                    </div>

                    {mode !== "smart" ? <div className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-medium opacity-75">{t("canvas.editors.brushSize")}</span>
                            <span className="font-semibold">{brushSize}px</span>
                        </div>
                        <Slider min={8} max={160} step={2} value={brushSize} onChange={setBrushSize} />
                    </div> : null}

                    <div className="space-y-2">
                        <div className="text-sm font-medium opacity-75">{t("canvas.editors.maskInstructions")}</div>
                        <Input.TextArea
                            rows={6}
                            value={prompt}
                            status={error && !prompt.trim() ? "error" : undefined}
                            placeholder={t("canvas.editors.maskPlaceholder")}
                            onChange={(event) => {
                                setPrompt(event.target.value);
                                setError("");
                            }}
                        />
                        <p id="mask-generate-hint" className="text-xs leading-5" style={{ color: token.colorTextSecondary }}>{t("canvas.editors.maskGenerateHint")}</p>
                        {error ? <div className="text-xs font-medium text-[#ef4444]">{error}</div> : null}
                    </div>

                    <div className="mt-auto flex items-center justify-between gap-2">
                        <Button icon={<RotateCcw className="size-4" />} disabled={smart.busy} onClick={resetMask}>
                            {t("canvas.editors.reset")}
                        </Button>
                        <div className="flex items-center gap-2">
                            <Button icon={<ImagePlus className="size-4" />} disabled={smart.busy || Boolean(smart.selection)} onClick={() => submit(false)}>
                                {t("canvas.editors.maskExport")}
                            </Button>
                            <Button type="primary" icon={<WandSparkles className="size-4" />} aria-describedby="mask-generate-hint" disabled={smart.busy || Boolean(smart.selection)} onClick={() => submit(true)}>
                                {t("canvas.editors.maskGenerate")}
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

function readCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    return {
        x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
        y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
    };
}

function clampBrushSize(value: number) {
    return Math.min(160, Math.max(8, Math.round(value / 2) * 2));
}

function clearCanvas(canvas: HTMLCanvasElement | null) {
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
}

function drawMaskStroke(context: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, size: number) {
    if (from.x === to.x && from.y === to.y) {
        context.beginPath();
        context.arc(to.x, to.y, size / 2, 0, Math.PI * 2);
        context.fill();
        return;
    }
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x, to.y);
    context.stroke();
}

function configureStrokeContext(context: CanvasRenderingContext2D, stroke: MaskStroke) {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = stroke.size;
    context.globalCompositeOperation = stroke.mode === "paint" ? "source-over" : "destination-out";
    context.strokeStyle = "#000";
    context.fillStyle = "#000";
}

function configurePreviewStrokeContext(context: CanvasRenderingContext2D, stroke: MaskStroke) {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = stroke.size;
    context.globalCompositeOperation = stroke.mode === "paint" ? "source-over" : "destination-out";
    context.strokeStyle = maskOverlayColor;
    context.fillStyle = maskOverlayColor;
}

function replayMask(strokes: MaskAction[], maskCanvas: HTMLCanvasElement | null, previewCanvas: HTMLCanvasElement | null) {
    const context = maskCanvas?.getContext("2d", { willReadFrequently: true });
    const previewContext = previewCanvas?.getContext("2d");
    if (!maskCanvas || !context || !previewCanvas || !previewContext) return;
    context.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    previewContext.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    for (const stroke of strokes) {
        if ("region" in stroke) {
            context.globalCompositeOperation = previewContext.globalCompositeOperation = stroke.mode === "paint" ? "source-over" : "destination-out";
            drawBinaryMask(context, stroke.region, "black");
            drawBinaryMask(previewContext, stroke.region, maskOverlayColor);
            continue;
        }
        configureStrokeContext(context, stroke);
        configurePreviewStrokeContext(previewContext, stroke);
        stroke.points.forEach((point, index) => {
            const previous = stroke.points[index - 1] || point;
            drawMaskStroke(context, previous, point, stroke.size);
            drawMaskStroke(previewContext, previous, point, stroke.size);
        });
    }
}

function canvasHasPaint(canvas: HTMLCanvasElement) {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return false;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) return true;
    }
    return false;
}

function buildMaskOverlay(image: HTMLImageElement, selectionCanvas: HTMLCanvasElement) {
    const canvas = document.createElement("canvas");
    canvas.width = selectionCanvas.width;
    canvas.height = selectionCanvas.height;
    const context = canvas.getContext("2d");
    if (!context) return selectionCanvas.toDataURL("image/png");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const overlay = document.createElement("canvas");
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    const overlayContext = overlay.getContext("2d");
    if (!overlayContext) return canvas.toDataURL("image/png");
    overlayContext.drawImage(selectionCanvas, 0, 0);
    overlayContext.globalCompositeOperation = "source-in";
    overlayContext.fillStyle = maskOverlayColor;
    overlayContext.fillRect(0, 0, overlay.width, overlay.height);
    context.globalAlpha = maskOverlayAlpha;
    context.drawImage(overlay, 0, 0);
    return canvas.toDataURL("image/png");
}

function drawBinaryMask(context: CanvasRenderingContext2D, mask: BinaryMask, color: string) {
    const canvas = document.createElement("canvas");
    canvas.width = mask.width; canvas.height = mask.height;
    const target = canvas.getContext("2d")!;
    const pixels = target.createImageData(mask.width, mask.height);
    for (let index = 0; index < mask.data.length; index++) pixels.data[index * 4 + 3] = mask.data[index] ? 255 : 0;
    target.putImageData(pixels, 0, 0);
    target.globalCompositeOperation = "source-in";
    target.fillStyle = color; target.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(canvas, 0, 0, context.canvas.width, context.canvas.height);
}
