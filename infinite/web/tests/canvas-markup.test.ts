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
    expect(result.references[0].dataUrl).toBe("");
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

test("connecting a mask to config expands its original and layer, keeping extra references", () => {
    const original = image("original");
    const mask = image("mask", { maskLayer: true, imageApiMask: { storageKey: "image:alpha", source: { storageKey: "image:original", url: "blob:original" } } });
    const other = image("other");
    const result = resolveImageApiMarkup(undefined, [original, mask, other], [ref("other"), ref("mask"), ref("original")]);
    expect(result.mask?.storageKey).toBe("image:alpha");
    expect(result.markup).toBeUndefined();
    expect(result.references.map((item) => item.storageKey)).toEqual(["image:original", "image:other"]);
});

test("a generated image stays its own reference despite retaining mask metadata for retry", () => {
    const generated = image("generated", { imageApiMask: { storageKey: "image:alpha", source: { storageKey: "image:original" } } });
    const result = resolveImageApiMarkup(generated, [generated], [ref("generated")]);
    expect(result.mask).toBeUndefined();
    expect(result.references.map((item) => item.storageKey)).toEqual(["image:generated"]);
});

test("mask promotion remaps prompt labels without swapping them twice", async () => {
    const { imageReferenceLabel } = await import("../src/lib/image-reference-prompt");
    const mask = image("mask", { maskLayer: true, imageApiMask: { storageKey: "image:alpha", source: { storageKey: "image:original" } } });
    const other = image("other");
    const result = resolveImageApiMarkup(undefined, [mask, other], [ref("other"), ref("mask")], `style=${imageReferenceLabel(0)} edit=${imageReferenceLabel(1)}`);
    expect(result.prompt).toBe(`style=${imageReferenceLabel(1)} edit=${imageReferenceLabel(0)}`);
});

test("overlay fallback shifts additional image labels without touching image ten as image one", async () => {
    const { imageReferenceLabel, remapImageReferenceLabels } = await import("../src/lib/image-reference-prompt");
    const indices = Array.from({ length: 10 }, (_, index) => index === 0 ? 0 : index + 1);
    expect(remapImageReferenceLabels(`${imageReferenceLabel(0)} / ${imageReferenceLabel(9)}`, indices)).toBe(`${imageReferenceLabel(0)} / ${imageReferenceLabel(10)}`);
});

test("editing a generated result uses its pixels and keeps historical markup only for retry", () => {
    const historicalMarkup = { storageKey: "image:overlay", source: { storageKey: "image:original" } };
    const generated = image("result", { generationType: "edit", generationMarkup: historicalMarkup });
    const result = resolveImageApiMarkup(generated, [generated], [ref("result")]);
    expect(result.markup).toBeUndefined();
    expect(result.references[0].storageKey).toBe("image:result");
    expect(generated.metadata?.generationMarkup).toBe(historicalMarkup);
});

test("annotation input retains a composite preview for external channel fallback", () => {
    const annotated = image("annotated", { imageApiMarkup: { storageKey: "image:overlay", source: { storageKey: "image:original" } } });
    const result = resolveImageApiMarkup(annotated, [annotated], [ref("annotated")]);
    expect(result.markup?.overlay?.storageKey).toBe("image:annotated");
    expect(result.references[0].storageKey).toBe("image:original");
});
