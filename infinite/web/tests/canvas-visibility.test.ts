import { expect, test } from "bun:test";
import { getHiddenNodeIds } from "../src/lib/canvas/canvas-node-visibility";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
const node = (id: string, hidden = false, groupId?: string): CanvasNodeData => ({ id, type: CanvasNodeType.Text, title: id, position: { x: 0, y: 0 }, width: 100, height: 80, hidden, metadata: { content: id, groupId } });
test("only hidden nodes are excluded and the source content is preserved", () => {
    const nodes = [node("visible"), node("hidden", true)];
    expect([...getHiddenNodeIds(nodes)]).toEqual(["hidden"]);
    expect(nodes[1].metadata?.content).toBe("hidden");
    expect(nodes).toHaveLength(2);
});
test("hiding a group hides its descendants while preserving independent child flags", () => {
    const nodes = [node("root", true), node("nested", false, "root"), node("child", false, "nested"), node("independent", true), node("visible")];
    expect([...getHiddenNodeIds(nodes)].sort()).toEqual(["child", "independent", "nested", "root"]);
    expect([...getHiddenNodeIds(nodes.map((item) => item.id === "root" ? { ...item, hidden: false } : item))]).toEqual(["independent"]);
    expect(nodes[2].hidden).toBe(false);
});
