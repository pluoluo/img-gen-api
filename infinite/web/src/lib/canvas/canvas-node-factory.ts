import { getNodeSpec, NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import type { AiConfig } from "@/stores/use-config-store";
import type { UploadedImage } from "@/services/image-storage";
import type { UploadedFile } from "@/services/file-storage";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasImageGenerationType, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeTypeId, type Position } from "@/types/canvas";

export function createCanvasNode(type: CanvasNodeTypeId, position: Position, metadata?: CanvasNodeMetadata): CanvasNodeData {
    const spec = getNodeSpec(type);
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    return {
        id,
        type,
        title: spec.title,
        position: {
            x: position.x - spec.width / 2,
            y: position.y - spec.height / 2,
        },
        width: spec.width,
        height: spec.height,
        metadata: { ...spec.metadata, ...metadata },
    };
}

export function imageMetadata(image: UploadedImage): CanvasNodeMetadata {
    return { content: image.url, storageKey: image.storageKey, status: "success", naturalWidth: image.width, naturalHeight: image.height, bytes: image.bytes, mimeType: image.mimeType };
}

export function removeBatchImage(node: CanvasNodeData, imageId: string): CanvasNodeData {
    const previous = node.metadata?.images || [];
    const images = previous.filter((image) => image.id !== imageId);
    const metadata = { ...node.metadata, images, count: images.length };
    if ((node.metadata?.primaryImageId || previous[0]?.id) !== imageId) return { ...node, metadata };
    const primary = images.find((image) => image.content) || images[0];
    const edge = Math.max(node.width, node.height);
    const size = primary?.content && !metadata.freeResize ? fitNodeSize(primary.naturalWidth, primary.naturalHeight, edge, edge) : { width: node.width, height: node.height };
    return {
        ...node,
        ...size,
        position: { x: node.position.x + (node.width - size.width) / 2, y: node.position.y + (node.height - size.height) / 2 },
        metadata: {
            ...metadata, primaryImageId: primary?.content ? primary.id : undefined,
            content: primary?.content, storageKey: primary?.storageKey,
            naturalWidth: primary?.naturalWidth, naturalHeight: primary?.naturalHeight,
            bytes: primary?.bytes, mimeType: primary?.mimeType, status: primary?.status || "idle", errorDetails: primary?.errorDetails,
        },
    };
}

export function videoMetadata(video: UploadedFile): CanvasNodeMetadata {
    return { content: video.url, storageKey: video.storageKey, status: "success", naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType || "video/mp4", durationMs: video.durationMs };
}

export function audioMetadata(audio: UploadedFile): CanvasNodeMetadata {
    return { content: audio.url, storageKey: audio.storageKey, status: "success", bytes: audio.bytes, mimeType: audio.mimeType || "audio/mpeg", durationMs: audio.durationMs };
}

export function referenceUrl(image: ReferenceImage) {
    return image.storageKey || image.url || (!image.dataUrl.startsWith("data:") ? image.dataUrl : undefined);
}

export function buildImageGenerationMetadata(type: CanvasImageGenerationType, config: AiConfig, count: number, references: ReferenceImage[]): CanvasNodeMetadata {
    return {
        generationType: type,
        model: config.model,
        size: config.size,
        quality: config.quality,
        ...(config.complexity ? { complexity: config.complexity } : {}),
        ...(config.background ? { background: config.background } : {}),
        ...(config.outputFormat && config.outputFormat !== "png" ? { outputFormat: config.outputFormat } : {}),
        ...(config.outputCompression ? { outputCompression: config.outputCompression } : {}),
        ...(config.frameCount ? { frameCount: config.frameCount } : {}),
        ...(config.frameDurationMs ? { frameDurationMs: config.frameDurationMs } : {}),
        count,
        references: references.map(referenceUrl).filter((url): url is string => Boolean(url)),
    };
}

export function buildAudioGenerationMetadata(config: AiConfig): CanvasNodeMetadata {
    return {
        model: config.model,
        audioVoice: config.audioVoice,
        audioFormat: config.audioFormat,
        audioSpeed: config.audioSpeed,
        audioInstructions: config.audioInstructions,
    };
}

export function applyNodeConfigPatch(node: CanvasNodeData, patch: Partial<CanvasNodeData["metadata"]>) {
    const safePatch = patch || {};
    const next = { ...node, metadata: { ...node.metadata, ...safePatch } };
    const spec = node.type === CanvasNodeType.Video ? NODE_DEFAULT_SIZE[CanvasNodeType.Video] : NODE_DEFAULT_SIZE[CanvasNodeType.Image];
    const size = typeof safePatch.size === "string" && !node.metadata?.content ? nodeSizeFromRatio(safePatch.size, spec.width, spec.height) : null;
    return size && (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video) ? { ...next, ...size, position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 } } : next;
}
