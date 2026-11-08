import { afterAll, afterEach, expect, test } from "bun:test";
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {}, removeItem: () => {} } });
const { createModelChannel, defaultConfig, resolveModelRequestConfig, buildApiUrl, withLocalProxy, useConfigStore } = await import("../src/stores/use-config-store");
const { requestImageQuestion } = await import("../src/services/api/image");
const fetchOriginal = globalThis.fetch;
const locationOriginal = Object.getOwnPropertyDescriptor(globalThis, "location");
const envOriginal = process.env.VITE_IMAGE_API;
const configOriginal = useConfigStore.getState().config;
afterEach(() => {
    globalThis.fetch = fetchOriginal;
    if (locationOriginal) Object.defineProperty(globalThis, "location", locationOriginal);
    else Reflect.deleteProperty(globalThis, "location");
    if (envOriginal === undefined) delete process.env.VITE_IMAGE_API;
    else process.env.VITE_IMAGE_API = envOriginal;
    useConfigStore.setState({ config: configOriginal });
});
afterAll(() => {
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
});
const channel = createModelChannel({ id: "mimo", name: "MiMo", baseUrl: "https://token-plan-cn.xiaomimimo.com/v1", apiKey: "test-placeholder", apiFormat: "openai", models: [{ name: "mimo-v2.6-pro", capability: "text" }] });
const config = { ...defaultConfig, systemPrompt: "Preserve facts", model: "mimo::mimo-v2.6-pro", textModel: "mimo::mimo-v2.6-pro", channels: [channel] };
const messages = [{ role: "user" as const, content: "你好" }];
function streamResponse(blocks: string[]) {
    const bytes = new TextEncoder().encode(blocks.join(""));
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
}

test("MiMo auto-selects Chat; other providers retain Responses and explicit protocol overrides persist", () => {
    expect(resolveModelRequestConfig(config, config.model).textApiFormat).toBe("chat-completions");
    for (const textApiFormat of ["responses", "chat-completions"] as const) {
        const current = createModelChannel({ ...channel, textApiFormat });
        expect(resolveModelRequestConfig({ ...config, channels: [current] }, config.model).textApiFormat).toBe(textApiFormat);
    }
    const other = { ...channel, baseUrl: "https://provider.example/v1" };
    expect(resolveModelRequestConfig({ ...config, channels: [other] }, config.model).textApiFormat).toBe("responses");
    expect(resolveModelRequestConfig({ ...config, channels: [{ ...channel, baseUrl: "https://api.xiaomimimo.com.evil.example/v1" }] }, config.model).textApiFormat).toBe("responses");
});
test("base URLs with or without v1/trailing slash join exactly once", () => {
    for (const base of ["https://token-plan-cn.xiaomimimo.com", "https://token-plan-cn.xiaomimimo.com/v1", "https://token-plan-cn.xiaomimimo.com/v1/"]) expect(buildApiUrl(base, "/chat/completions")).toBe("https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
});
test("text generation submits messages and consumes fragmented Unicode SSE without returning reasoning", async () => {
    let calls = 0; const deltas: string[] = [];
    globalThis.fetch = (async (url, init) => {
        calls++;
        expect(String(url)).toBe("https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("mimo-v2.6-pro"); expect(body.messages).toEqual([{ role: "system", content: "Preserve facts" }, ...messages]);
        expect(body.stream).toBe(true); expect(body.input).toBeUndefined(); expect(body.reasoning_effort).toBeUndefined();
        return streamResponse([': heartbeat\r\n\r\n', 'data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\r\n\r\n', 'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n', 'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n', 'data: [DONE]\n\n']);
    }) as typeof fetch;
    expect(await requestImageQuestion(config, messages, text => deltas.push(text))).toBe("你好，世界");
    expect(deltas).toEqual(["你好", "你好，世界"]); expect(calls).toBe(1);
});
test("JSON responses returned by nonstreaming compatible channels are accepted", async () => {
    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: "完成" } }] })) as typeof fetch;
    const deltas: string[] = [];
    expect(await requestImageQuestion(config, messages, text => deltas.push(text))).toBe("完成"); expect(deltas).toEqual(["完成"]);
});
test("provider errors remain errors with one request and no endpoint retry", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return Response.json({ error: { message: "model not permitted" } }, { status: 403 }); }) as typeof fetch;
    await expect(requestImageQuestion(config, messages, () => {})).rejects.toThrow("HTTP 403：model not permitted"); expect(calls).toBe(1);
});
test("SSE error payloads and cancellation propagate", async () => {
    globalThis.fetch = (async () => streamResponse(['data: {"error":{"message":"quota unavailable"}}\n\n'])) as typeof fetch;
    await expect(requestImageQuestion(config, messages, () => {})).rejects.toThrow("quota unavailable");
    const controller = new AbortController(); controller.abort();
    globalThis.fetch = (async (_url, init) => { expect(init?.signal).toBe(controller.signal); throw new DOMException("cancelled", "AbortError"); }) as typeof fetch;
    await expect(requestImageQuestion(config, messages, () => {}, { signal: controller.signal })).rejects.toThrow("请求已取消");
});
test("explicit Responses preserves the original endpoint and input format", async () => {
    globalThis.fetch = (async (url, init) => {
        expect(String(url)).toBe("https://token-plan-cn.xiaomimimo.com/v1/responses");
        const body = JSON.parse(String(init?.body)); expect(body.input).toBeDefined(); expect(body.messages).toBeUndefined();
        return streamResponse(['data: {"type":"response.output_text.delta","delta":"原有接口"}\n\n', 'data: [DONE]\n\n']);
    }) as typeof fetch;
    expect(await requestImageQuestion({ ...config, channels: [{ ...channel, textApiFormat: "responses" }] }, messages, () => {})).toBe("原有接口");
});

test("image-api deployments relay official MiMo endpoints before the optional local proxy", () => {
    process.env.VITE_IMAGE_API = "1";
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://canvas.example" } });
    useConfigStore.setState({ config: { ...configOriginal, proxyEnabled: true, proxyUrl: "http://127.0.0.1:23210" } });
    for (const cluster of ["api", "token-plan-cn", "token-plan-sgp", "token-plan-ams"]) {
        for (const path of ["chat/completions", "responses", "models"]) expect(withLocalProxy(`https://${cluster}.xiaomimimo.com/v1/${path}`)).toBe(`/api/v1/infinite/mimo/${cluster}/v1/${path}`);
    }
    expect(withLocalProxy("/api/v1/infinite/mimo/token-plan-cn/v1/chat/completions")).toBe("/api/v1/infinite/mimo/token-plan-cn/v1/chat/completions");
    for (const url of ["https://token-plan-cn.xiaomimimo.com.evil.example/v1/chat/completions", "https://token-plan-cn.xiaomimimo.com/v1/images/generations", "https://key@token-plan-cn.xiaomimimo.com/v1/chat/completions"]) expect(withLocalProxy(url).startsWith("/api/v1/infinite/mimo/")).toBe(false);
});
test("standalone deployments preserve direct requests", () => {
    delete process.env.VITE_IMAGE_API;
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://canvas.example" } });
    useConfigStore.setState({ config: { ...configOriginal, proxyEnabled: false } });
    expect(withLocalProxy("https://token-plan-cn.xiaomimimo.com/v1/chat/completions")).toBe("https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
});
test("same-origin relay errors preserve the server's readable detail", async () => {
    globalThis.fetch = (async () => Response.json({ detail: "供应商连接失败，请稍后重试" }, { status: 502 })) as typeof fetch;
    await expect(requestImageQuestion(config, messages, () => {})).rejects.toThrow("HTTP 502：供应商连接失败");
});
