import type { CanvasNodeData } from "@/types/canvas";

export function getHiddenNodeIds(nodes: CanvasNodeData[]) {
    const children = new Map<string, string[]>();
    const hidden = new Set(nodes.filter((node) => node.hidden).map((node) => node.id));
    for (const node of nodes) {
        if (node.metadata?.groupId) {
            const group = children.get(node.metadata.groupId) || [];
            group.push(node.id);
            children.set(node.metadata.groupId, group);
        }
    }
    const queue = [...hidden];
    for (const id of queue) {
        for (const child of children.get(id) || []) {
            if (hidden.has(child)) continue;
            hidden.add(child);
            queue.push(child);
        }
    }
    return hidden;
}
