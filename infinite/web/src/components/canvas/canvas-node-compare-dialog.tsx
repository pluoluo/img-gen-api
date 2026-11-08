import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Button } from "antd";
import { ArrowLeftRight, ChevronsLeftRight, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasNodeCompareDialog({ source, target, onClose }: { source: CanvasNodeData; target: CanvasNodeData; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const dialogRef = useRef<HTMLDivElement>(null);
    const areaRef = useRef<HTMLDivElement>(null);
    const [area, setArea] = useState({ width: 1, height: 1 });
    const [size, setSize] = useState<{ width: number; height: number } | null>(null);
    const [error, setError] = useState("");
    const [position, setPosition] = useState(50);
    const [swapped, setSwapped] = useState(false);
    const [dragging, setDragging] = useState(false);
    const left = swapped ? target : source;
    const right = swapped ? source : target;
    const scale = size ? Math.min(area.width / size.width, area.height / size.height) : 1;

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
    useLayoutEffect(() => {
        const area = areaRef.current!;
        const observer = new ResizeObserver(() => setArea({ width: area.clientWidth, height: area.clientHeight }));
        observer.observe(area);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        let cancelled = false;
        const load = (url: string) =>
            new Promise<HTMLImageElement>((resolve, reject) => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error("图片加载失败，请关闭后重新选择"));
                image.src = url;
            });
        setSize(null);
        setError("");
        setPosition(50);
        setSwapped(false);
        void Promise.all([load(source.metadata!.content!), load(target.metadata!.content!)])
            .then(([image]) => {
                if (!cancelled) setSize({ width: image.naturalWidth, height: image.naturalHeight });
            })
            .catch((error: Error) => {
                if (!cancelled) setError(error.message);
            });
        return () => {
            cancelled = true;
        };
    }, [source.metadata?.content, target.metadata?.content]);
    useEffect(() => {
        const handle = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopImmediatePropagation();
                onClose();
            }
            if (event.key === "Tab") {
                const controls = Array.from(dialogRef.current!.querySelectorAll<HTMLElement>('button:not(:disabled), [role="slider"]'));
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
        };
        window.addEventListener("keydown", handle, true);
        return () => window.removeEventListener("keydown", handle, true);
    }, [onClose]);
    const updatePosition = (event: ReactPointerEvent<HTMLDivElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPosition(Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)));
    };
    const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
        setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    };
    return createPortal(
        <div
            ref={dialogRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="AB 图片对比"
            data-canvas-no-zoom
            className="fixed inset-0 z-[2000] flex flex-col p-3 sm:p-5"
            style={{ background: theme.canvas.background, color: theme.node.text }}
            onKeyDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className="mx-auto flex max-w-full shrink-0 items-center gap-3 pb-3">
                <Button type="text" aria-label="关闭对比" icon={<X size={18} />} onClick={onClose} />
                <span className="text-sm font-medium">AB 对比</span>
                <Button type="text" disabled={!size} icon={<ArrowLeftRight size={16} />} onClick={() => setSwapped(!swapped)}>
                    交换 A / B
                </Button>
            </div>
            <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
                {size ? (
                    <div
                        data-image-comparison
                        className="relative shrink-0 touch-none overflow-hidden"
                        style={{ width: size.width * scale, height: size.height * scale, cursor: "ew-resize" }}
                        onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            event.preventDefault();
                            event.currentTarget.setPointerCapture(event.pointerId);
                            setDragging(true);
                            updatePosition(event);
                            event.currentTarget.querySelector<HTMLElement>('[role="slider"]')?.focus();
                        }}
                        onPointerMove={(event) => {
                            if (dragging) updatePosition(event);
                        }}
                        onPointerUp={stopDragging}
                        onPointerCancel={stopDragging}
                        onLostPointerCapture={() => setDragging(false)}
                    >
                        <img src={right.metadata!.content} alt={`B：${right.title}`} draggable={false} className="pointer-events-none absolute inset-0 h-full w-full select-none object-contain" />
                        <div data-comparison-left className="pointer-events-none absolute inset-0" style={{ clipPath: `inset(0 ${100 - position}% 0 0)`, background: theme.canvas.background }}>
                            <img src={left.metadata!.content} alt={`A：${left.title}`} draggable={false} className="absolute inset-0 h-full w-full select-none object-contain" />
                        </div>
                        <span className="pointer-events-none absolute left-3 top-3 max-w-[40%] truncate rounded px-2 py-1 text-xs" style={{ background: theme.toolbar.panel }}>
                            A · {left.title || "图片"}
                        </span>
                        <span className="pointer-events-none absolute right-3 top-3 max-w-[40%] truncate rounded px-2 py-1 text-xs" style={{ background: theme.toolbar.panel }}>
                            B · {right.title || "图片"}
                        </span>
                        <div
                            role="slider"
                            tabIndex={0}
                            aria-label="对比分隔线"
                            aria-orientation="horizontal"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(position)}
                            aria-valuetext={`A ${Math.round(position)}%，B ${Math.round(100 - position)}%`}
                            className="group absolute inset-y-0 w-11 -translate-x-1/2 outline-none"
                            style={{ left: `${position}%` }}
                            onKeyDown={(event) => {
                                const next =
                                    event.key === "Home"
                                        ? 0
                                        : event.key === "End"
                                          ? 100
                                          : event.key === "ArrowLeft"
                                            ? position - 1
                                            : event.key === "ArrowRight"
                                              ? position + 1
                                              : event.key === "PageDown"
                                                ? position - 10
                                                : event.key === "PageUp"
                                                  ? position + 10
                                                  : null;
                                if (next !== null) {
                                    event.preventDefault();
                                    setPosition(Math.max(0, Math.min(100, next)));
                                }
                            }}
                        >
                            <span className="absolute inset-y-0 left-1/2 -ml-px w-0.5" style={{ background: theme.node.activeStroke, boxShadow: `0 0 0 1px ${theme.canvas.background}` }} />
                            <span className="absolute left-1/2 top-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border group-focus-visible:ring-2 group-focus-visible:ring-current" style={{ background: theme.toolbar.panel, borderColor: theme.node.activeStroke }}>
                                <ChevronsLeftRight size={24} />
                            </span>
                        </div>
                    </div>
                ) : (
                    <span role={error ? "alert" : "status"} className="text-sm">
                        {error || "正在加载对比图片…"}
                    </span>
                )}
            </div>
            <div className="pt-3 text-center text-xs" style={{ color: theme.node.muted }}>
                左右拖动中间分隔线 · 图片按比例居中对齐 · Esc 返回画布
            </div>
        </div>,
        document.body,
    );
}
