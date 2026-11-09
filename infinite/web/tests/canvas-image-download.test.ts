import { afterAll, expect, test } from "bun:test";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

const { imageExtension } = await import("../src/lib/canvas/canvas-generation-helpers");

test.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
    ["image/gif", "gif"],
    ["image/svg+xml", "svg"],
])("blob URL downloads use %s metadata and the .%s extension", (mimeType, extension) => {
    expect(imageExtension("blob:https://example.com/image-id", mimeType)).toBe(extension);
});

test("SVG MIME parameters and case do not leak into the filename", () => {
    expect(imageExtension("blob:svg", "IMAGE/SVG+XML; charset=utf-8")).toBe("svg");
});

test("data URL uses its actual type, including non-base64 SVG", () => {
    expect(imageExtension("data:image/gif;base64,R0lGODlh", "image/png")).toBe("gif");
    expect(imageExtension("data:image/svg+xml,%3Csvg%3E%3C/svg%3E")).toBe("svg");
    expect(imageExtension("data:image/jpeg;base64,/9j/")).toBe("jpg");
});

test("missing or non-image metadata keeps the PNG fallback", () => {
    expect(imageExtension("blob:unknown")).toBe("png");
    expect(imageExtension("blob:unknown", "application/octet-stream")).toBe("png");
});
