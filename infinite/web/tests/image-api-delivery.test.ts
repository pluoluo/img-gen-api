import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { acknowledgeImageApiResult, flushImageApiAcknowledgements, imageApiAcknowledgements, waitForImageApiTask, type ImageApiTaskHandle } from "../src/services/api/image-api";

const originalFetch = globalThis.fetch;
const pending = new Map<string, ImageApiTaskHandle>();
let spies: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
    pending.clear();
    spies = [
        spyOn(imageApiAcknowledgements, "setItem").mockImplementation(async (key, value) => { pending.set(key, value as ImageApiTaskHandle); return value; }),
        spyOn(imageApiAcknowledgements, "removeItem").mockImplementation(async (key) => { pending.delete(key); }),
        spyOn(imageApiAcknowledgements, "iterate").mockImplementation(async (callback) => { for (const [key, value] of pending) callback(value, key, 1); }),
        spyOn(console, "warn").mockImplementation(() => {}),
    ];
});
afterEach(async () => {
    await flushImageApiAcknowledgements();
    spies.forEach(spy => spy.mockRestore());
    globalThis.fetch = originalFetch;
});

test("receiving a client-owned result does not acknowledge it before the owner is saved", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
        calls.push(url);
        return Response.json({ status: "completed", client_storage: true, images: [{ base64: "pixels" }] });
    }) as typeof fetch;
    const handle = { clientRequestId: "identity", taskId: "task" };
    const [image] = await waitForImageApiTask(handle, new AbortController().signal);
    expect(image.imageApiTask).toEqual(handle);
    expect(calls).toEqual(["/api/v1/tasks/task"]);
    expect(pending.size).toBe(0);
});

test("acknowledgement is journaled locally before POST and removed only on success", async () => {
    const handle = { clientRequestId: "identity", taskId: "task" };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        expect(pending.get("task")).toEqual(handle);
        expect(url).toBe("/api/v1/tasks/task/acknowledge");
        expect(JSON.parse(String(init?.body))).toEqual({ client_request_id: "identity" });
        return Response.json({ result_released_at: "saved" });
    }) as typeof fetch;
    await acknowledgeImageApiResult({ dataUrl: "blob:stored", imageApiTask: handle }, "image:stored");
    await flushImageApiAcknowledgements();
    expect(pending.size).toBe(0);
});

test("network failure retains acknowledgement for a later app load without regenerating", async () => {
    const handle = { clientRequestId: "identity", taskId: "task" };
    const calls: string[] = [];
    let offline = true;
    globalThis.fetch = (async (url: string) => {
        calls.push(url);
        if (offline) throw new Error("offline");
        return Response.json({ result_released_at: "saved" });
    }) as typeof fetch;
    await acknowledgeImageApiResult({ dataUrl: "blob:stored", imageApiTask: handle }, "image:stored");
    await flushImageApiAcknowledgements();
    expect(pending.get("task")).toEqual(handle);
    offline = false;
    await flushImageApiAcknowledgements();
    expect(pending.size).toBe(0);
    expect(calls.every(url => url.endsWith("/acknowledge"))).toBe(true);
});

test("results saved during another acknowledgement are drained in the same run", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
        calls.push(url);
        if (url.includes("/first/")) await blocked;
        return Response.json({ result_released_at: "saved" });
    }) as typeof fetch;
    await acknowledgeImageApiResult({ dataUrl: "blob:first", imageApiTask: { clientRequestId: "one", taskId: "first" } }, "image:first");
    await acknowledgeImageApiResult({ dataUrl: "blob:second", imageApiTask: { clientRequestId: "two", taskId: "second" } }, "image:second");
    release();
    await flushImageApiAcknowledgements();
    expect(pending.size).toBe(0);
    expect(calls).toContain("/api/v1/tasks/second/acknowledge");
});

test("failure to persist the acknowledgement never releases server pixels", async () => {
    spyOn(imageApiAcknowledgements, "setItem").mockRejectedValueOnce(new Error("quota"));
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
    await acknowledgeImageApiResult({ dataUrl: "blob:stored", imageApiTask: { clientRequestId: "identity", taskId: "task" } }, "image:stored");
    expect(calls).toBe(0);
});

test("released results explain where to find local pixels without a replacement paid request", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
        calls.push(url);
        return Response.json({ status: "completed", client_storage: true, result_released_at: "saved", images: [] });
    }) as typeof fetch;
    await expect(waitForImageApiTask({ clientRequestId: "identity", taskId: "task" }, new AbortController().signal)).rejects.toThrow("原浏览器");
    expect(calls).toEqual(["/api/v1/tasks/task"]);
});

test("legacy and external results are never queued for release", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
    await acknowledgeImageApiResult({ dataUrl: "blob:legacy" }, "image:legacy");
    expect(calls).toBe(0);
    expect(pending.size).toBe(0);
});

test("a remote URL fallback without locally stored pixels never releases the result", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({}); }) as typeof fetch;
    await acknowledgeImageApiResult({ dataUrl: "https://remote.test/result.png", imageApiTask: { clientRequestId: "identity", taskId: "task" } }, undefined);
    expect(calls).toBe(0);
    expect(pending.size).toBe(0);
});
