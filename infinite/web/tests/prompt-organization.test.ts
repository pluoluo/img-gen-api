import { expect, test } from "bun:test";
import { organizePrompts, promptMatches, isChinesePrompt, applyPromptClassification, promptClassificationKeys } from "../src/services/api/prompt-organization";
import type { Prompt } from "../src/services/api/prompts";
const example = (patch: Partial<Prompt> = {}): Prompt => ({ id: "a", sourceId: "source-a", category: "Author Repository", title: "电影人像", prompt: "A cinematic portrait with soft light.", description: "", coverUrl: "", referenceImageUrls: [], tags: ["Photography", "@Author", "Unknown", "gpt-image-2"], preview: "", createdAt: "", updatedAt: "", githubUrl: "https://example.com/source", ...patch });

test("exact originals and known bilingual versions merge without losing provenance", () => {
    const items = organizePrompts([
        example({ promptZh: "柔光电影人像", coverUrl: "/local-image" }),
        example({ id: "b", sourceId: "source-b", prompt: "  A cinematic   portrait with soft light. " }),
        example({ id: "c", sourceId: "source-c", prompt: "柔光电影人像" }),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].origins).toHaveLength(3);
    expect(items[0].originalPrompt).toBe("A cinematic portrait with soft light.");
    expect(items[0].promptZh).toBe("柔光电影人像");
    expect(items[0].coverUrl).toBe("/local-image");
});

test("similar titles and same authors never merge different instructions", () => {
    const items = organizePrompts([example(), example({ id: "b", prompt: "A cinematic portrait in hard light." })]);
    expect(items).toHaveLength(2);
});

test("authors and models are not style filters, title intent wins over noisy tags", () => {
    const [item] = organizePrompts([example({ title: "人物胶片写真", tags: ["UI", "Tech", "Commerce", "Realistic", "@Someone"] })]);
    expect(item.topic).toBe("人像与写真");
    expect(item.tags).toEqual(["写实摄影", "胶片"]);
});

test("Chinese search covers translated text and supports multiple terms", () => {
    const [item] = organizePrompts([example({ promptZh: "柔光电影人像，蓝色背景" })]);
    expect(promptMatches(item, "蓝色 人像")).toBe(true);
    expect(promptMatches(item, "portrait")).toBe(true);
    expect(promptMatches(item, "蓝色 产品")).toBe(false);
    expect(isChinesePrompt('Keep the exact sign "你好" in an otherwise fully English prompt.')).toBe(false);
});

test("personal duplicates remain independently editable and saved content is unchanged", () => {
    const original = example({ id: "local:a", sourceId: "local-library", tags: ["我的自定义标签"], prompt: "第一段\n\n第二段" });
    const other = { ...original, id: "local:b" };
    const snapshot = JSON.stringify(original);
    const items = organizePrompts([original, other]);
    expect(items).toHaveLength(2);
    expect(items[0].tags).toEqual(["我的自定义标签"]);
    expect(items[0].prompt).toBe("第一段\n\n第二段");
    expect(JSON.stringify(original)).toBe(snapshot);
});

test("English titles get understandable Chinese names without modifying their prompt", () => {
    const [item] = organizePrompts([example({ title: "a premium claw machine" })]);
    expect(item.title).toBe("高端品牌抓娃娃机");
    expect(item.originalTitle).toBe("a premium claw machine");
    expect(item.prompt).toBe("A cinematic portrait with soft light.");
});


test("manual classification overrides inference, including an intentionally empty tag list", () => {
    const [original] = organizePrompts([example()]);
    const key = promptClassificationKeys(original)[0];
    const [corrected] = organizePrompts([example()], { [key]: { topic: "产品与电商", tags: [], updatedAt: 1 } });
    expect(corrected.topic).toBe("产品与电商");
    expect(corrected.tags).toEqual([]);
    expect(corrected.originalPrompt).toBe(original.originalPrompt);
    expect(corrected.classificationEdited).toBe(true);
    const restored = applyPromptClassification(corrected, {});
    expect(restored.topic).toBe(original.topic);
    expect(restored.tags).toEqual(original.tags);
    expect(restored.classificationEdited).toBe(false);
});

test("corrections follow a deduplicated translation even when enabled source order changes", () => {
    const en = example({ promptZh: "柔光电影人像" });
    const zh = example({ id: "zh", sourceId: "translated-source", prompt: "柔光电影人像" });
    const [merged] = organizePrompts([en, zh]);
    const overrides = Object.fromEntries(promptClassificationKeys(merged).map(key => [key, { topic: "插画与艺术", tags: ["自定义校正"], updatedAt: 1 }]));
    const [changed] = organizePrompts([zh, en], overrides);
    expect(changed.topic).toBe("插画与艺术");
    expect(changed.tags).toEqual(["自定义校正"]);
    expect(changed.origins).toHaveLength(2);
    expect(organizePrompts([en], overrides)[0].tags).toEqual(["自定义校正"]);
});
