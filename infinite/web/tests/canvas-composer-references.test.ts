import { afterAll, expect, test } from "bun:test";
import type { CanvasConnection, CanvasNodeData } from "../src/types/canvas";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { buildNodeGenerationContext } = await import("../src/components/canvas/canvas-node-generation");
const { CanvasNodeType } = await import("../src/types/canvas");

const image = (id: string): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Image,
    title: id,
    position: { x: 0, y: 0 },
    width: 100,
    height: 80,
    metadata: { content: `blob:${id}`, storageKey: `image:${id}` },
});
const config = (composerContent: string): CanvasNodeData => ({
    id: "config",
    type: CanvasNodeType.Config,
    title: "生成配置",
    position: { x: 200, y: 0 },
    width: 280,
    height: 180,
    metadata: { composerContent, generationMode: "image" },
});
const text = (id: string, content: string): CanvasNodeData => ({
    id,
    type: CanvasNodeType.Text,
    title: id,
    position: { x: 0, y: 100 },
    width: 200,
    height: 80,
    metadata: { content },
});
const connect = (fromNodeId: string, toNodeId = "config"): CanvasConnection => ({ id: `${fromNodeId}->${toNodeId}`, fromNodeId, toNodeId });

test("composer without @ images still submits connected references in connection order", () => {
    const first = image("first");
    const second = image("second");
    const node = config("红圈中的文字改为短句");
    const context = buildNodeGenerationContext(node.id, [first, second, node], [connect(first.id), connect(second.id)], node.metadata!.composerContent!);
    expect(context.referenceImages.map((item) => item.id)).toEqual(["first", "second"]);
    expect(context.imageCount).toBe(2);
    expect(context.prompt).toBe("红圈中的文字改为短句");
});

test("composer @ images keep mention order and do not append unmentioned connected images", () => {
    const first = image("first");
    const second = image("second");
    const third = image("third");
    const node = config(`只用 @[node:${second.id}] 和 @[node:${first.id}]`);
    const context = buildNodeGenerationContext(node.id, [first, second, third, node], [connect(first.id), connect(second.id), connect(third.id)], node.metadata!.composerContent!);
    expect(context.referenceImages.map((item) => item.id)).toEqual(["second", "first"]);
    expect(context.imageCount).toBe(2);
});

test("composer that only @ mentions text still includes connected images in connection order", () => {
    const first = image("first");
    const second = image("second");
    const note = text("note", "上游说明");
    const node = config(`按 @[node:${note.id}] 修改`);
    const context = buildNodeGenerationContext(node.id, [first, second, note, node], [connect(first.id), connect(second.id), connect(note.id)], node.metadata!.composerContent!);
    expect(context.referenceImages.map((item) => item.id)).toEqual(["first", "second"]);
    expect(context.prompt).toContain("上游说明");
});
