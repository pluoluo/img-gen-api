import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { uploadImage } from "@/services/image-storage";
import { flushCanvasStorage, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { createCanvasNode, imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { CanvasNodeType } from "@/types/canvas";

// The original generator hosts Infinite in a same-origin workspace frame.
export function useLegacyCanvasBridge() {
    const hydrated = useCanvasStore((state) => state.hydrated);
    const navigate = useNavigate();
    const { message } = App.useApp();
    const { t } = useTranslation();
    useEffect(() => {
        if (import.meta.env.VITE_IMAGE_API !== "1" || window.parent === window || !hydrated) return;
        const receive = (event: MessageEvent) => {
            if (event.origin !== window.location.origin || event.source !== window.parent || event.data?.type !== "canvas-import" || typeof event.data.url !== "string") return;
            const url = event.data.url as string;
            try {
                if (!url.startsWith("data:image/") && new URL(url, window.location.origin).origin !== window.location.origin) return;
            } catch {
                return;
            }
            void (async () => {
                const image = await uploadImage(url);
                if (!image.storageKey) throw new Error("参考图无法读取，请重新选择图片");
                const size = fitNodeSize(image.width, image.height);
                const node = { ...createCanvasNode(CanvasNodeType.Image, { x: 0, y: 0 }, imageMetadata(image)), ...size, position: { x: 0, y: 0 } };
                const id = useCanvasStore.getState().importProject({ title: t("topNav.legacyResult"), nodes: [node], connections: [], viewport: { x: 80, y: 80, k: 1 } });
                await flushCanvasStorage();
                await navigate(`/canvas/${id}`);
                window.parent.postMessage({ type: "canvas-imported", url }, window.location.origin);
            })().catch((error) => message.error(String(error)));
        };
        window.addEventListener("message", receive);
        window.parent.postMessage({ type: "canvas-ready" }, window.location.origin);
        return () => window.removeEventListener("message", receive);
    }, [hydrated, message, navigate, t]);
}
