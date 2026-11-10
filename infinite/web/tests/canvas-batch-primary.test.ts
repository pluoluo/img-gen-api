import { afterAll, expect, test } from "bun:test";
import type { CanvasNodeData, CanvasNodeImage } from "../src/types/canvas";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});
const { removeBatchImage } = await import("../src/lib/canvas/canvas-node-factory");
const { buildNodeGenerationContext } = await import("../src/components/canvas/canvas-node-generation");
const image = (id: string): CanvasNodeImage => ({ id, content: `blob:${id}`, storageKey: `image:${id}`, naturalWidth: 2048, naturalHeight: 1024, bytes: 100, mimeType: "image/png", status: "success" });
const node = (): CanvasNodeData => ({ id: "batch", type: "image", title: "batch", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { ...image("a"), primaryImageId: "a", images: [image("a"), image("b")] } });

test("deleting the primary updates both display metadata and subsequent edit input", () => {
    const updated = removeBatchImage(node(), "a");
    expect(updated.metadata?.primaryImageId).toBe("b");
    expect(updated.metadata?.storageKey).toBe("image:b");
    expect(updated.metadata?.content).toBe("blob:b");
    expect(updated.width / updated.height).toBe(2);
    expect(buildNodeGenerationContext(updated.id, [updated], [], "edit").referenceImages[0].storageKey).toBe("image:b");
});

test("deleting the last image clears every old primary field", () => {
    const updated = removeBatchImage(removeBatchImage(node(), "a"), "b");
    expect(updated.metadata?.content).toBeUndefined();
    expect(updated.metadata?.storageKey).toBeUndefined();
    expect(updated.metadata?.naturalWidth).toBeUndefined();
    expect(updated.metadata?.bytes).toBeUndefined();
    expect(updated.metadata?.primaryImageId).toBeUndefined();
    expect(buildNodeGenerationContext(updated.id, [updated], [], "edit").referenceImages).toEqual([]);
});

test("deleting a secondary preserves the current primary and free resize dimensions", () => {
    const current = node();
    current.metadata!.freeResize = true;
    const secondary = removeBatchImage(current, "b");
    expect(secondary.metadata?.storageKey).toBe("image:a");
    const primary = removeBatchImage(current, "a");
    expect([primary.width, primary.height]).toEqual([200, 200]);
});

test("a pending replacement leaves primary unset so the next completion can populate it", () => {
    const current = node();
    current.metadata!.images![1] = { ...image("b"), content: "", storageKey: undefined, status: "loading", naturalWidth: 0, naturalHeight: 0, bytes: 0 };
    const updated = removeBatchImage(current, "a");
    expect(updated.metadata?.content).toBe("");
    expect(updated.metadata?.storageKey).toBeUndefined();
    expect(updated.metadata?.primaryImageId).toBeUndefined();
    expect(updated.metadata?.status).toBe("loading");
});
