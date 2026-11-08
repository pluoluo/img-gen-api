import i18n from "@/i18n";
import { buildApiUrl, isMiMoBaseUrl, type AiConfig } from "@/stores/use-config-store";
import type { AiTextMessage } from "./image";

type ChatPayload = {
    error?: { message?: string };
    message?: string;
    detail?: string;
    code?: number;
    msg?: string;
    choices?: Array<{ delta?: { content?: string }; message?: { content?: string } }>;
};

function checkPayload(payload: ChatPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || payload.message || i18n.t("apiErrors.requestFailed"));
}

export async function requestChatCompletions(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: { signal?: AbortSignal }) {
    const response = await fetch(buildApiUrl(config.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
            model: config.model,
            messages,
            stream: true,
            // MiMo documents `thinking`, rather than OpenAI's reasoning_effort; retain its model defaults.
            ...(config.reasoningEffort && config.reasoningEffort !== "auto" && !isMiMoBaseUrl(config.baseUrl) ? { reasoning_effort: config.reasoningEffort } : {}),
        }),
        signal: options?.signal,
    });
    if (!response.ok) {
        const raw = await response.text();
        let detail = "";
        try {
            const payload = JSON.parse(raw) as ChatPayload;
            detail = payload.error?.message || payload.msg || payload.message || payload.detail || "";
        } catch {
            detail = raw;
        }
        throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ""}`);
    }
    // Some compatible channels return JSON even when stream=true.
    if (response.headers.get("content-type")?.includes("application/json")) {
        const payload = (await response.json()) as ChatPayload;
        checkPayload(payload);
        const text = payload.choices?.[0]?.message?.content || "";
        if (text) onDelta(text);
        return text;
    }
    if (!response.body) throw new Error(i18n.t("apiErrors.noContent"));
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "",
        text = "";
    const consume = (block: string) => {
        const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
            .trim();
        if (!data || data === "[DONE]") return;
        const payload = JSON.parse(data) as ChatPayload;
        checkPayload(payload);
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) {
            text += delta;
            onDelta(text);
        }
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let match;
            while ((match = /\r?\n\r?\n/.exec(buffer))) {
                consume(buffer.slice(0, match.index));
                buffer = buffer.slice(match.index + match[0].length);
            }
            if (done) {
                if (buffer.trim()) consume(buffer);
                break;
            }
        }
        return text;
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
