import { afterAll, expect, test } from "bun:test";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});
const { readImageQuickToolsConfig } = await import("../src/components/canvas/canvas-image-toolbar-tools");

test("existing customized toolbars gain comparison without restoring previously hidden annotation", () => {
    const config = readImageQuickToolsConfig({ annotationVersion: 1, ids: ["view"], showLabels: true });
    expect(config.ids).toEqual(["compare", "view"]);
    expect(config.showLabels).toBe(true);
});
test("saving a toolbar without comparison keeps the user's choice on reopening", () => {
    const config = readImageQuickToolsConfig({ annotationVersion: 1, comparisonVersion: 1, ids: ["view"], showLabels: false });
    expect(config.ids).toEqual(["view"]);
});
test("legacy toolbars and fresh defaults expose annotation and comparison", () => {
    for (const value of [["view"], null]) {
        const config = readImageQuickToolsConfig(value);
        expect(config.ids).toContain("annotate");
        expect(config.ids).toContain("compare");
        expect(config.ids).toContain("view");
    }
});
