import { afterAll, expect, test } from "bun:test";
import type { CanvasConnection, CanvasNodeData } from "../src/types/canvas";
import type { ReferenceImage } from "../src/types/image";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { resolveImageApiMarkup } = await import("../src/lib/canvas/canvas-generation-helpers");
const { CanvasNodeType } = await import("../src/types/canvas");

const image = (id: string, extra: CanvasNodeData["metadata"] = {}): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Image,
    title: id,
    position: { x: 0, y: 0 },
    width: 100,
    height: 80,
    metadata: { content: `blob:${id}`, storageKey: `image:${id}`, ...extra },
});
const ref = (id: string): ReferenceImage => ({ id, name: `${id}.png`, type: "image/png", dataUrl: `blob:${id}`, storageKey: `image:${id}` });

test("annotated node submits original first and keeps overlay out of image[]", () => {
    const original = image("original");
    const annotated = image("annotated", { imageApiMarkup: { storageKey: "image:overlay", source: { storageKey: "image:original", url: "blob:original" } } });
    const result = resolveImageApiMarkup(annotated, [original, annotated], [ref("annotated"), ref("original")]);
    expect(result.markup?.storageKey).toBe("image:overlay");
    expect(result.references.map((item) => item.storageKey)).toEqual(["image:original"]);
});

test("config uses markup only when the first image is the annotated node", () => {
    const original = image("original");
    const annotated = image("annotated", { imageApiMarkup: { storageKey: "image:overlay", source: { storageKey: "image:original", url: "blob:original" } } });
    const other = image("other");
    const config: CanvasNodeData = { id: "config", type: CanvasNodeType.Config, title: "config", position: { x: 0, y: 0 }, width: 100, height: 80, metadata: {} };
    const first = resolveImageApiMarkup(config, [original, annotated, other, config], [ref("annotated"), ref("other")]);
    expect(first.markup?.storageKey).toBe("image:overlay");
    expect(first.references.map((item) => item.storageKey)).toEqual(["image:original", "image:other"]);
    const second = resolveImageApiMarkup(config, [original, annotated, other, config], [ref("other"), ref("annotated")]);
    expect(second.markup).toBeUndefined();
    expect(second.references.map((item) => item.storageKey)).toEqual(["image:other", "image:original"]);
});
