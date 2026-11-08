import { afterAll, expect, test } from "bun:test";
import type { CanvasNodeData } from "../src/types/canvas";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => { if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else Reflect.deleteProperty(globalThis, "localStorage"); });
const { defaultConfig, createModelChannel } = await import("../src/stores/use-config-store");
const { CanvasNodeType } = await import("../src/types/canvas");
const { applyOptimizedText, buildTextOptimizationConfig, textPromptForOptimization } = await import("../src/lib/canvas/canvas-text-optimization");
const source = '只调整参考图2的展台吊顶为暖黄色，保留布局与品牌“天味食品”。\n\n画面标题必须是"Tianwei 2026"，比例3:2。';
const result = '修改内容：\n仅将参考图2的展台吊顶调整为暖黄色。\n\n保留内容：\n保留布局与品牌“天味食品”。画面标题必须是"Tianwei 2026"，比例3:2。';
const node = (patch: Partial<CanvasNodeData> = {}): CanvasNodeData => ({ id: "text", type: CanvasNodeType.Text, title: "现有提示词", position: { x: 10, y: 20 }, width: 320, height: 220, metadata: { content: source }, ...patch });

test("optimization uses the saved text model and conservative rules without the expansion contract", () => {
    const channel = createModelChannel({ id: "writer", baseUrl: "https://example.invalid/v1", apiKey: "fixture", models: [{ name: "text-a", capability: "text" }, { name: "text-b", capability: "text" }] });
    const config = { ...defaultConfig, systemPrompt: "用户原有风格偏好", channels: [channel], textModel: "writer::text-a" };
    const generated = buildTextOptimizationConfig(config, node({ metadata: { model: "writer::text-b", content: source } }));
    expect(generated.model).toBe("writer::text-b");
    expect(generated.systemPrompt).toContain(config.systemPrompt);
    expect(generated.systemPrompt).toContain("最小幅度");
    expect(generated.systemPrompt).toContain("GPT Image 2.5");
    expect(generated.systemPrompt).toContain("逐字保留");
    expect(generated.systemPrompt).not.toContain("先明确主体、用途和核心场景，再补充");
    expect(config.systemPrompt).toBe("用户原有风格偏好");
});

test("atomic replacement preserves node geometry and only changes the selected batch variant", () => {
    const original = node({ metadata: { primaryTextId: "primary", texts: [{ id: "other", status: "success", content: "其他版本不变" }, { id: "primary", status: "success", content: source }], fontSize: 18 } });
    const changed = applyOptimizedText(original, source, result, "primary");
    expect(changed.metadata?.content).toBe(result);
    expect(changed.metadata?.texts?.[0].content).toBe("其他版本不变");
    expect(changed.metadata?.texts?.[1].content).toBe(result);
    expect(changed.position).toEqual(original.position);
    expect(changed.width).toBe(original.width);
    expect(changed.metadata?.fontSize).toBe(18);
    expect(textPromptForOptimization(original)).toBe(source);
});

test("edits and batch selection changes while waiting must never be overwritten", () => {
    expect(() => applyOptimizedText(node({ metadata: { content: "用户最新修改" } }), source, result)).toThrow("已在优化期间修改");
    expect(() => applyOptimizedText(node({ metadata: { content: source, primaryTextId: "other" } }), source, result, "primary")).toThrow("已在优化期间修改");
});

test("missing exact text, changed numbers, and empty answers are rejected", () => {
    expect(() => applyOptimizedText(node(), source, result.replace("天味食品", "新品牌"))).toThrow("引号内");
    expect(() => applyOptimizedText(node(), source, result.replace("2026", "2027"))).toThrow();
    expect(() => applyOptimizedText(node(), source, result.replace("参考图2", "参考图4").replace("3:2", "3:4"))).toThrow("数字");
    expect(() => applyOptimizedText(node(), source, result.replace("参考图2", "参考图3"))).toThrow("参考编号");
    expect(() => applyOptimizedText(node(), source, result.replace("3:2", "2:3"))).toThrow("比例");
    expect(() => applyOptimizedText(node(), source, result + " 增加4个物体。")).toThrow("数字");
    expect(() => applyOptimizedText(node(), source, " ")).toThrow("未返回");
});

test("visible content falls back to the first batch item and empty nodes stay empty", () => {
    expect(textPromptForOptimization(node({ metadata: { texts: [{ id: "first", status: "success", content: source }] } }))).toBe(source);
    expect(textPromptForOptimization(node({ metadata: {} }))).toBe("");
});


test("text revision prioritizes requested changes without the creation formatting contract", async () => {
    const { buildGenerationConfig } = await import("../src/lib/canvas/canvas-generation-helpers");
    const { CANVAS_IMAGE_PROMPT_SYSTEM_PROMPT, CANVAS_TEXT_EDIT_SYSTEM_PROMPT } = await import("../src/lib/canvas/canvas-image-prompt");
    const config = { ...defaultConfig, systemPrompt: "用户原有偏好" };
    const editing = buildGenerationConfig(config, node(), "text");
    expect(editing.systemPrompt).toBe(config.systemPrompt + "\n\n" + CANVAS_TEXT_EDIT_SYSTEM_PROMPT);
    expect(editing.systemPrompt).toContain("本次修改意见优先");
    expect(editing.systemPrompt).toContain("用户要求大幅修改时应充分落实");
    expect(editing.systemPrompt).toContain("不强制分段、加标题");
    expect(editing.systemPrompt).not.toContain("标题独占一行");
    expect(buildGenerationConfig(config, node({ metadata: { content: "  " } }), "text").systemPrompt).toContain(CANVAS_IMAGE_PROMPT_SYSTEM_PROMPT);
    expect(buildGenerationConfig(config, node(), "image").systemPrompt).toBe(config.systemPrompt);
    expect(buildTextOptimizationConfig(config, node()).systemPrompt).not.toContain(CANVAS_TEXT_EDIT_SYSTEM_PROMPT);
});
