import { afterEach, expect, test } from "bun:test";
import { isImageApiChannel, requestImageApi, waitForImageApiTask, type ImageApiTaskHandle } from "../src/services/api/image-api";

const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
});
const input = { sub_model: "gpt-image-2.5-flare", prompt: "test", n: 2, image_base64s: ["first", "second"] };

test("submission identity is durably acknowledged before POST, then task ID is recorded", async () => {
    const handles: ImageApiTaskHandle[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
            expect(handles.length).toBe(1);
            expect(JSON.parse(String(init.body)).client_request_id).toBe(handles[0].clientRequestId);
            return Response.json({ task_id: "bound-task" });
        }
        expect(handles[1].taskId).toBe("bound-task");
        return Response.json({ status: "completed", images: [{ base64: "result" }] });
    }) as typeof fetch;
    await requestImageApi(input, new AbortController().signal, {
        onImageApiTask: async (handle) => {
            handles.push(handle);
        },
    });
    expect(handles.length).toBe(2);
});

test("refresh resumes an existing task with no generation POST", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (url: string) => {
        requests.push(url);
        return Response.json({ status: "completed", images: [{ base64: "existing-result" }] });
    }) as typeof fetch;
    await requestImageApi(input, new AbortController().signal, { imageApiTask: { clientRequestId: "identity", taskId: "existing" } });
    expect(requests).toEqual(["/api/v1/tasks/existing"]);
});

test("an unconfirmed submission is resolved by identity after refresh without resubmitting", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (url: string) => {
        requests.push(url);
        return Response.json(requests.length === 1 ? { task_id: "found" } : { status: "completed", images: [{ base64: "existing-result" }] });
    }) as typeof fetch;
    await waitForImageApiTask({ clientRequestId: "unconfirmed" }, new AbortController().signal);
    expect(requests).toEqual(["/api/v1/submissions/unconfirmed", "/api/v1/tasks/found"]);
});

test("only the same-origin integration endpoint bypasses provider credentials", () => {
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://local.test" } });
    expect(isImageApiChannel("http://local.test/api/v1/infinite/")).toBe(true);
    expect(isImageApiChannel("https://external.test/api/v1/infinite")).toBe(false);
    expect(isImageApiChannel("http://local.test/other")).toBe(false);
});

test("one submission preserves reference order and returns every task result", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return Response.json(calls.length === 1 ? { task_id: "existing" } : { status: "completed", images: [{ base64: "result" }, { url: "https://example.test/image.png" }] });
    }) as typeof fetch;
    const result = await requestImageApi(input, new AbortController().signal);
    expect(result.map((image) => image.dataUrl)).toEqual(["data:image/png;base64,result", "https://example.test/image.png"]);
    expect(calls.map((call) => call.url)).toEqual(["/api/v1/infinite/generate", "/api/v1/tasks/existing"]);
    const submitted = JSON.parse(String(calls[0].init?.body));
    expect(submitted.image_base64s).toEqual(["first", "second"]);
    expect(submitted.client_request_id.length).toBeGreaterThan(0);
});

test("a failed task reports the server error without resubmitting", async () => {
    let count = 0;
    globalThis.fetch = (async () => Response.json(++count === 1 ? { task_id: "failed" } : { status: "failed", error: "provider failed" })) as typeof fetch;
    await expect(requestImageApi(input, new AbortController().signal)).rejects.toThrow("provider failed");
    expect(count).toBe(2);
});

test("a missing task after service restart never creates a replacement", async () => {
    let count = 0;
    globalThis.fetch = (async () => (++count === 1 ? Response.json({ task_id: "lost" }) : Response.json({ detail: "Task not found" }, { status: 404 }))) as typeof fetch;
    await expect(requestImageApi(input, new AbortController().signal)).rejects.toThrow("Task not found");
    expect(count).toBe(2);
});

test("cancelling polling does not submit another generation", async () => {
    let count = 0;
    const controller = new AbortController();
    globalThis.fetch = (async () => {
        if (++count === 1) return Response.json({ task_id: "running" });
        controller.abort(new Error("cancelled"));
        return Response.json({ status: "running", images: [] });
    }) as typeof fetch;
    await expect(requestImageApi(input, controller.signal)).rejects.toThrow("cancelled");
    expect(count).toBe(2);
});
