import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Button, Tooltip } from "antd";
import { Eraser, Pencil, Redo2, Save, Square, Type, Undo2, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

type Point = { x: number; y: number };
type Tool = "pen" | "rectangle" | "eraser" | "text";
type Mark = { tool: Tool; color: string; width: number; points: Point[]; text?: string };
type TextDraft = Point & { value: string; color: string; width: number };

// Erasing affects this transparent annotation layer only, never the source pixels.
function paint(canvas: HTMLCanvasElement, marks: Mark[]) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建标注画布");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const mark of marks) {
        ctx.save();
        ctx.globalCompositeOperation = mark.tool === "eraser" ? "destination-out" : "source-over";
        ctx.strokeStyle = ctx.fillStyle = mark.color;
        ctx.lineWidth = mark.width;
        ctx.lineCap = ctx.lineJoin = "round";
        const first = mark.points[0];
        const last = mark.points[mark.points.length - 1];
        if (mark.tool === "text") {
            ctx.font = `${mark.width}px sans-serif`;
            ctx.textBaseline = "top";
            (mark.text || "").split("\n").forEach((line, i) => ctx.fillText(line, first.x, first.y + i * mark.width * 1.3));
        } else if (mark.tool === "rectangle") {
            ctx.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y);
        } else {
            ctx.beginPath();
            ctx.moveTo(first.x, first.y);
            mark.points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
            if (mark.points.length === 1) {
                ctx.arc(first.x, first.y, mark.width / 2, 0, Math.PI * 2);
                ctx.fill();
            } else ctx.stroke();
        }
        ctx.restore();
    }
}

export function CanvasNodeAnnotationDialog({ dataUrl, onClose, onSave }: { dataUrl: string; onClose: () => void; onSave: (dataUrl: string) => Promise<void> }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [image, setImage] = useState<HTMLImageElement | null>(null);
    const [tool, setTool] = useState<Tool>("pen");
    const [color, setColor] = useState("#ef4444");
    const [width, setWidth] = useState(6);
    const [marks, setMarks] = useState<Mark[]>([]);
    const [redo, setRedo] = useState<Mark[]>([]);
    const [draft, setDraft] = useState<TextDraft | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const dialogRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const areaRef = useRef<HTMLDivElement>(null);
    const strokeRef = useRef<Mark | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [area, setArea] = useState({ width: 1, height: 1 });
    const scale = image ? Math.min(area.width / image.naturalWidth, area.height / image.naturalHeight) : 1;

    useEffect(() => {
        const overflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        dialogRef.current?.focus();
        if (window.parent !== window) window.parent.postMessage({ type: "canvas-editor-fullscreen", active: true }, window.location.origin);
        return () => {
            document.body.style.overflow = overflow;
            if (window.parent !== window) window.parent.postMessage({ type: "canvas-editor-fullscreen", active: false }, window.location.origin);
        };
    }, []);

    useEffect(() => {
        let disposed = false;
        const source = new Image();
        source.crossOrigin = "anonymous";
        source.onload = () => {
            if (!disposed) setImage(source);
        };
        source.onerror = () => {
            if (!disposed) setError("图片加载失败，请退出后重试");
        };
        source.src = dataUrl;
        return () => {
            disposed = true;
        };
    }, [dataUrl]);

    useLayoutEffect(() => {
        const element = areaRef.current!;
        const observer = new ResizeObserver(() => setArea({ width: element.clientWidth, height: element.clientHeight }));
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (canvasRef.current && image) paint(canvasRef.current, marks);
    }, [image, marks]);
    useEffect(() => {
        if (draft) textareaRef.current?.focus();
    }, [Boolean(draft)]);

    const withText = () => (draft?.value.trim() ? [...marks, { tool: "text" as const, color: draft.color, width: draft.width, points: [{ x: draft.x, y: draft.y }], text: draft.value }] : marks);
    const commitText = () => {
        const next = withText();
        if (next !== marks) {
            setMarks(next);
            setRedo([]);
        }
        setDraft(null);
        return next;
    };
    const undo = () => {
        if (draft) {
            setDraft(null);
            return;
        }
        if (marks.length) {
            setRedo((prev) => [...prev, marks[marks.length - 1]]);
            setMarks(marks.slice(0, -1));
        }
    };
    const redoMark = () => {
        if (redo.length) {
            setMarks((prev) => [...prev, redo[redo.length - 1]]);
            setRedo(redo.slice(0, -1));
        }
    };
    useEffect(() => {
        const handle = (event: KeyboardEvent) => {
            if (event.key === "Tab") {
                const controls = Array.from(dialogRef.current!.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)"));
                const first = controls[0];
                const last = controls[controls.length - 1];
                if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
                    event.preventDefault();
                    last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                }
            }
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!saving) onClose();
            } else if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase()) && !draft) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (!saving) {
                    if (event.shiftKey || event.key.toLowerCase() === "y") redoMark();
                    else undo();
                }
            }
        };
        window.addEventListener("keydown", handle, true);
        return () => window.removeEventListener("keydown", handle, true);
    });

    const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        return { x: ((event.clientX - rect.left) / rect.width) * image!.naturalWidth, y: ((event.clientY - rect.top) / rect.height) * image!.naturalHeight };
    };
    const start = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!image || saving || event.button !== 0) return;
        event.preventDefault();
        const p = point(event);
        if (draft) {
            commitText();
            return;
        }
        if (tool === "text") {
            setDraft({ ...p, value: "", color, width: Math.max(18, width * 4) / scale });
            return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        strokeRef.current = { tool, color, width: width / scale, points: [p] };
        paint(event.currentTarget, [...marks, strokeRef.current]);
    };
    const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        const stroke = strokeRef.current;
        if (!stroke) return;
        const p = point(event);
        if (stroke.tool === "rectangle") stroke.points = [stroke.points[0], p];
        else stroke.points.push(p);
        paint(event.currentTarget, [...marks, stroke]);
    };
    const finish = (event: ReactPointerEvent<HTMLCanvasElement>) => {
        if (!strokeRef.current) return;
        const stroke = strokeRef.current;
        if (event.type !== "pointercancel") {
            setMarks((prev) => [...prev, stroke]);
            setRedo([]);
        } else paint(event.currentTarget, marks);
        strokeRef.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };
    const save = async () => {
        if (!image || saving) return;
        setSaving(true);
        setError("");
        try {
            const overlay = document.createElement("canvas");
            overlay.width = image.naturalWidth;
            overlay.height = image.naturalHeight;
            paint(overlay, commitText());
            const output = document.createElement("canvas");
            output.width = overlay.width;
            output.height = overlay.height;
            const ctx = output.getContext("2d");
            if (!ctx) throw new Error("无法保存标注图片");
            ctx.drawImage(image, 0, 0);
            ctx.drawImage(overlay, 0, 0);
            await onSave(output.toDataURL("image/png"));
        } catch (err) {
            setError(err instanceof Error ? err.message : "保存失败，请重试");
        } finally {
            setSaving(false);
        }
    };
    const tools = [
        { id: "pen", label: "画笔", icon: Pencil },
        { id: "rectangle", label: "矩形", icon: Square },
        { id: "eraser", label: "橡皮", icon: Eraser },
        { id: "text", label: "文字", icon: Type },
    ] as const;

    return createPortal(
        <div
            ref={dialogRef}
            tabIndex={-1}
            onKeyDown={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="图片标注"
            data-canvas-no-zoom
            className="fixed inset-0 z-[2000] flex flex-col p-3 sm:p-5"
            style={{ background: theme.canvas.background, color: theme.node.text }}
            onWheel={(event) => event.stopPropagation()}
        >
            <div role="toolbar" aria-label="标注工具" className="mx-auto flex max-w-full shrink-0 flex-wrap items-center justify-center gap-1 pb-3">
                <Tooltip title="取消（Esc）">
                    <Button type="text" aria-label="取消标注" disabled={saving} icon={<X size={18} />} onClick={onClose} />
                </Tooltip>
                {tools.map(({ id, label, icon: Icon }) => (
                    <Tooltip key={id} title={label}>
                        <Button
                            type={tool === id ? "default" : "text"}
                            aria-label={label}
                            aria-pressed={tool === id}
                            disabled={saving || !image}
                            icon={<Icon size={18} />}
                            onClick={() => {
                                commitText();
                                setTool(id);
                            }}
                        />
                    </Tooltip>
                ))}
                <label className="mx-1 flex items-center gap-1 text-xs">
                    颜色
                    <input
                        aria-label="标注颜色"
                        type="color"
                        value={color}
                        disabled={saving}
                        onChange={(e) => {
                            setColor(e.target.value);
                            setDraft((prev) => (prev ? { ...prev, color: e.target.value } : null));
                        }}
                        className="h-7 w-8 cursor-pointer border-0 bg-transparent p-0"
                    />
                </label>
                <label className="mx-1 flex items-center gap-2 text-xs">
                    粗细
                    <input
                        aria-label="标注粗细"
                        type="range"
                        min="1"
                        max="40"
                        value={width}
                        disabled={saving}
                        onChange={(e) => {
                            const value = Number(e.target.value);
                            setWidth(value);
                            setDraft((prev) => (prev ? { ...prev, width: Math.max(18, value * 4) / scale } : null));
                        }}
                        className="w-20"
                    />
                    <span className="w-4 tabular-nums">{width}</span>
                </label>
                <Tooltip title="撤销（Ctrl/⌘ Z）">
                    <Button type="text" aria-label="撤销标注" disabled={saving || (!marks.length && !draft)} icon={<Undo2 size={18} />} onClick={undo} />
                </Tooltip>
                <Tooltip title="重做（Ctrl/⌘ Shift Z）">
                    <Button type="text" aria-label="重做标注" disabled={saving || !redo.length || Boolean(draft)} icon={<Redo2 size={18} />} onClick={redoMark} />
                </Tooltip>
                <Button type="primary" icon={<Save size={16} />} loading={saving} disabled={!image} onClick={() => void save()}>
                    保存
                </Button>
            </div>
            <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
                {image ? (
                    <div className="relative shrink-0 overflow-hidden" style={{ width: image.naturalWidth * scale, height: image.naturalHeight * scale }}>
                        <img src={dataUrl} alt="待标注图片" draggable={false} className="absolute inset-0 h-full w-full select-none" />
                        <canvas
                            ref={canvasRef}
                            aria-label="标注画布"
                            width={image.naturalWidth}
                            height={image.naturalHeight}
                            className="absolute inset-0 h-full w-full touch-none"
                            style={{ cursor: tool === "text" ? "text" : "crosshair" }}
                            onPointerDown={start}
                            onPointerMove={move}
                            onPointerUp={finish}
                            onPointerCancel={finish}
                            onLostPointerCapture={finish}
                        />
                        {draft ? (
                            <textarea
                                ref={textareaRef}
                                aria-label="标注文字"
                                disabled={saving}
                                placeholder="输入标注文字"
                                value={draft.value}
                                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                                className="absolute resize-none border border-dashed bg-transparent p-0 leading-[1.3] outline-none"
                                style={{
                                    left: draft.x * scale,
                                    top: draft.y * scale,
                                    width: Math.max(1, image.naturalWidth * scale - draft.x * scale),
                                    height: Math.max(draft.width * scale * 1.5, draft.value.split("\n").length * draft.width * scale * 1.3),
                                    fontSize: draft.width * scale,
                                    color: draft.color,
                                    borderColor: theme.node.activeStroke,
                                    whiteSpace: "pre",
                                    overflowX: "auto",
                                }}
                            />
                        ) : null}
                    </div>
                ) : (
                    <span role="status">{error ? "" : "正在加载图片…"}</span>
                )}
            </div>
            <div className="min-h-6 pt-2 text-center text-xs" style={{ color: theme.node.muted }}>
                {error ? <span role="alert">{error}</span> : tool === "text" ? "点击图片添加文字，点击空白处完成；保存为新图片，保留原图" : "保存为新图片，保留原图 · Esc 取消"}
            </div>
        </div>,
        document.body,
    );
}
