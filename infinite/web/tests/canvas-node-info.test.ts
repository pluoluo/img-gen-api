import { expect, test } from "bun:test";

import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { canvasNodeImageBytes, canvasNodeImagePixels, formatPixelSize } from "../src/lib/canvas/canvas-node-info";

const imageNode = (metadata: CanvasNodeData["metadata"], size = { width: 280, height: 160 }): CanvasNodeData => ({
    id: "node-1",
    type: CanvasNodeType.Image,
    title: "image",
    position: { x: 0, y: 0 },
    ...size,
    metadata,
});

test("image node info uses stored pixel size, not the canvas node box", () => {
    const pixels = canvasNodeImagePixels(imageNode({ naturalWidth: 3840, naturalHeight: 2160 }));
    expect(pixels).toEqual({ width: 3840, height: 2160 });
    expect(formatPixelSize(pixels!)).toBe("3840 x 2160 px");
});

test("image groups report the primary image pixels", () => {
    expect(canvasNodeImagePixels(imageNode({
        primaryImageId: "b",
        naturalWidth: 100,
        naturalHeight: 80,
        images: [
            { id: "a", status: "success", content: "", naturalWidth: 1024, naturalHeight: 1024, bytes: 10, mimeType: "image/png" },
            { id: "b", status: "success", content: "", naturalWidth: 2048, naturalHeight: 1152, bytes: 20, mimeType: "image/jpeg" },
        ],
    }))).toEqual({ width: 2048, height: 1152 });
});

test("text nodes and empty images have no pixel size", () => {
    expect(canvasNodeImagePixels({ id: "text", type: CanvasNodeType.Text, title: "t", position: { x: 0, y: 0 }, width: 200, height: 80 })).toBeNull();
    expect(canvasNodeImagePixels(imageNode({ status: "loading", naturalWidth: 0, naturalHeight: 0 }))).toBeNull();
});

test("image info prefers stored byte size", () => {
    expect(canvasNodeImageBytes(imageNode({ bytes: 4096 }))).toBe(4096);
    expect(canvasNodeImageBytes(imageNode({
        primaryImageId: "b",
        bytes: 1,
        images: [
            { id: "a", status: "success", content: "", naturalWidth: 1, naturalHeight: 1, bytes: 10, mimeType: "image/png" },
            { id: "b", status: "success", content: "", naturalWidth: 1, naturalHeight: 1, bytes: 99, mimeType: "image/png" },
        ],
    }))).toBe(99);
});
