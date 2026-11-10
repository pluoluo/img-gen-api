import { getDataUrlByteSize } from "@/lib/image-utils";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function primaryImage(node: CanvasNodeData) {
    const images = node.metadata?.images || [];
    return images.find((image) => image.id === (node.metadata?.primaryImageId || images[0]?.id));
}

export function canvasNodeImagePixels(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image) return null;
    const primary = primaryImage(node);
    const source = primary && [primary.naturalWidth, primary.naturalHeight].every((size) => Number.isFinite(size) && size > 0) ? primary : node.metadata;
    const width = Math.round(source?.naturalWidth || 0);
    const height = Math.round(source?.naturalHeight || 0);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    return { width, height };
}

export function formatPixelSize(size: { width: number; height: number }) {
    return `${size.width} x ${size.height} px`;
}

export function canvasNodeImageBytes(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image) return 0;
    // Once a primary exists, root metadata may still describe an older image.
    const source = primaryImage(node) || node.metadata;
    if (source?.bytes && Number.isFinite(source.bytes) && source.bytes > 0) return source.bytes;
    const content = source?.content || "";
    return /^data:image\/[^;,]+;base64,/i.test(content) ? getDataUrlByteSize(content) : 0;
}
