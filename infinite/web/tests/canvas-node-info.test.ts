import { afterAll, expect, test } from "bun:test";

import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});
const { canvasNodeImageBytes, canvasNodeImagePixels, formatPixelSize } = await import("../src/lib/canvas/canvas-node-info");

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

const primary = (patch = {}) => ({ id: "b", status: "success" as const, content: "", naturalWidth: 2048, naturalHeight: 1152, bytes: 0, mimeType: "image/png", ...patch });

test("incomplete primary dimensions fall back as a pair in either direction", () => {
    for (const dimensions of [{ naturalWidth: 2048, naturalHeight: 0 }, { naturalWidth: 0, naturalHeight: 1152 }]) {
        expect(canvasNodeImagePixels(imageNode({
            naturalWidth: 3840, naturalHeight: 2160, primaryImageId: "b", images: [primary(dimensions)],
        }))).toEqual({ width: 3840, height: 2160 });
    }
});

test("incomplete dimensions from different sources never form a valid size", () => {
    expect(canvasNodeImagePixels(imageNode({
        naturalWidth: 0, naturalHeight: 2160, images: [primary({ naturalHeight: 0 })],
    }))).toBeNull();
    expect(canvasNodeImagePixels(imageNode({ naturalWidth: Infinity, naturalHeight: 2160 }))).toBeNull();
});

test("both info helpers select the first image when no primary id is set", () => {
    const node = imageNode({ naturalWidth: 100, naturalHeight: 80, bytes: 100, images: [primary({ bytes: 42 })] });
    expect(canvasNodeImagePixels(node)).toEqual({ width: 2048, height: 1152 });
    expect(canvasNodeImageBytes(node)).toBe(42);
});

test("missing primary bytes use its own data URL even when root bytes belong to an old image", () => {
    for (const bytes of [0, 120]) {
        expect(canvasNodeImageBytes(imageNode({
            primaryImageId: "b", bytes, content: "data:image/png;base64,QUJDREVG", images: [primary({ content: "data:image/png;base64,QQ==" })],
        }))).toBe(1);
    }
});

test("unknown primary size does not fall back to the old root image", () => {
    for (const content of ["", "blob:current", "https://example.test/image,a,b.png"]) {
        expect(canvasNodeImageBytes(imageNode({
            bytes: 120, content: "data:image/png;base64,QUJDREVG", images: [primary({ content })],
        }))).toBe(0);
    }
});

test("single image data URLs still supply byte size and stored bytes take precedence", () => {
    expect(canvasNodeImageBytes(imageNode({ content: "data:image/png;base64,QUI=" }))).toBe(2);
    expect(canvasNodeImageBytes(imageNode({ bytes: 100, content: "data:image/png;base64,QUI=" }))).toBe(100);
    expect(canvasNodeImageBytes(imageNode({ content: "blob:unknown" }))).toBe(0);
    expect(canvasNodeImageBytes(null)).toBe(0);
    expect(canvasNodeImageBytes({ ...imageNode({ bytes: 100 }), type: CanvasNodeType.Text })).toBe(0);
});
