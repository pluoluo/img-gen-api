import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function canvasNodeImagePixels(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image) return null;
    const images = node.metadata?.images || [];
    const primary = images.find((image) => image.id === (node.metadata?.primaryImageId || images[0]?.id));
    const width = Math.round(primary?.naturalWidth || node.metadata?.naturalWidth || 0);
    const height = Math.round(primary?.naturalHeight || node.metadata?.naturalHeight || 0);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
}

export function formatPixelSize(size: { width: number; height: number }) {
    return `${size.width} x ${size.height} px`;
}

export function canvasNodeImageBytes(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image) return 0;
    const images = node.metadata?.images || [];
    const primary = images.find((image) => image.id === (node.metadata?.primaryImageId || images[0]?.id));
    return primary?.bytes || node.metadata?.bytes || 0;
}
