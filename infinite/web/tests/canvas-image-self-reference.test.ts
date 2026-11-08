import { expect, test } from "bun:test";
import { getGenerationResourceNodes, getMentionResourceNodes } from "../src/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasNodeData, type CanvasConnection } from "../src/types/canvas";
const image = (id: string, content = `blob:${id}`): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 80, metadata: { content, storageKey: `image:${id}` } });
const original = image("original");
const annotated = image("annotated");
const edge: CanvasConnection = { id: "lineage", fromNodeId: original.id, toNodeId: annotated.id };

test("editing an annotated image includes itself first and keeps the original input", () => {
    for (const getInputs of [getGenerationResourceNodes, getMentionResourceNodes]) {
        const result = getInputs(annotated.id, [original, annotated], [edge]);
        expect(result.map(node => node.id)).toEqual(["annotated", "original"]);
        expect(result[0].metadata?.storageKey).toBe("image:annotated");
    }
});
test("an image without upstream connections still references itself; an empty node does not", () => {
    expect(getGenerationResourceNodes(annotated.id, [annotated], []).map(n => n.id)).toEqual([annotated.id]);
    const empty = image("empty", "");
    expect(getGenerationResourceNodes(empty.id, [empty], [])).toEqual([]);
});
test("self input stays first when a downstream config supplies additional references", () => {
    const config: CanvasNodeData = { ...image("config", ""), type: CanvasNodeType.Config };
    const connections = [{ id: "source-config", fromNodeId: original.id, toNodeId: config.id }, { id: "current-config", fromNodeId: annotated.id, toNodeId: config.id }];
    for (const getInputs of [getGenerationResourceNodes, getMentionResourceNodes]) expect(getInputs(annotated.id, [original, annotated, config], connections).map(n => n.id)).toEqual([annotated.id, original.id]);
    expect(getGenerationResourceNodes(config.id, [original, annotated, config], connections).map(n => n.id)).toEqual([original.id, annotated.id]);
});
