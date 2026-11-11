import { nanoid } from "nanoid";
import localforage from "localforage";

export const IMAGE_API_PATH = "/api/v1/infinite";

export function isImageApiChannel(baseUrl: string) {
    return isImageApiEndpoint(baseUrl, IMAGE_API_PATH);
}

export function isManagedImageApiProvider(baseUrl: string) {
    return isImageApiEndpoint(baseUrl, `${IMAGE_API_PATH}/openai`);
}

function isImageApiEndpoint(baseUrl: string, path: string) {
    if (typeof location === "undefined") return false;
    try {
        const url = new URL(baseUrl, location.origin);
        return url.origin === location.origin && url.pathname.replace(/\/+$/, "") === path;
    } catch {
        return false;
    }
}

function publicImageApiError(raw: unknown): string {
    let text = "";
    if (typeof raw === "string") text = raw;
    else if (raw && typeof raw === "object") {
        const body = raw as { detail?: unknown; msg?: string; message?: string };
        if (typeof body.detail === "string") text = body.detail;
        else if (Array.isArray(body.detail)) text = body.detail.map((item: { msg?: string }) => item.msg || "").filter(Boolean).join("；");
        else text = body.msg || body.message || "";
    }
    text = text.trim();
    if (!text) return "生成失败，请稍后重试。详细原因见日志页。";
    if (/Traceback|DecompressionBomb|File "|httpx\.|PIL\.|DOS attack/i.test(text)) {
        return "生成失败，请稍后重试。详细原因见日志页。";
    }
    return text;
}

export async function imageApiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, init);
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(publicImageApiError(body));
    }
    return response.json();
}

type ImageApiInput = {
    sub_model: string;
    prompt: string;
    size?: string;
    n: number;
    quality?: string;
    complexity?: string;
    background?: string;
    output_format?: string;
    output_compression?: number;
    frame_count?: number;
    frame_duration_ms?: number;
    image_base64s?: string[];
    mask_base64?: string;
    markup_base64?: string;
    preserve_outside_mask?: boolean;
    save_to_gallery?: boolean;
};
type ImageTask = {
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    images: { base64?: string; url?: string; mime_type?: string }[];
    error?: string;
    client_storage?: boolean;
    result_released_at?: string;
};

export type ImageApiTaskHandle = { clientRequestId: string; taskId?: string; failed?: boolean };
export type ImageApiMask = { storageKey: string; source: { storageKey?: string; url?: string }; overlay?: { storageKey?: string; url?: string } };
export type ImageApiMarkup = ImageApiMask;
export type ImageApiLifecycle = { imageApiTask?: ImageApiTaskHandle; onImageApiTask?: (handle: ImageApiTaskHandle) => Promise<void>; imageApiMask?: ImageApiMask; imageApiMarkup?: ImageApiMarkup };

export const imageApiAcknowledgements = localforage.createInstance({ name: "infinite-canvas", storeName: "image_api_acknowledgements" });
let acknowledgementRun: Promise<void> | undefined;
let acknowledgementPending = false;

// Called only after both the image Blob and its owning canvas/job are durable.
// Keep failed acknowledgements locally and retry on the next result or app load.
export async function acknowledgeImageApiResult(image: { dataUrl: string; imageApiTask?: ImageApiTaskHandle }, storageKey: string | undefined) {
    const handle = image.imageApiTask;
    if (!handle?.taskId || !storageKey) return;
    try {
        await imageApiAcknowledgements.setItem(handle.taskId, handle);
        void flushImageApiAcknowledgements();
    } catch (error) {
        console.warn("结果已保存到本地，服务器领取确认稍后重试", error);
    }
}

export function flushImageApiAcknowledgements(): Promise<void> {
    acknowledgementPending = true;
    if (acknowledgementRun) return acknowledgementRun;
    const run = async () => {
        do {
            acknowledgementPending = false;
            const handles: ImageApiTaskHandle[] = [];
            await imageApiAcknowledgements.iterate<ImageApiTaskHandle, void>((handle) => { handles.push(handle); });
            for (const handle of handles) {
                try {
                    await imageApiRequest(`/api/v1/tasks/${encodeURIComponent(handle.taskId!)}/acknowledge`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ client_request_id: handle.clientRequestId }),
                    });
                    await imageApiAcknowledgements.removeItem(handle.taskId!);
                } catch (error) {
                    console.warn("结果已保存到本地，服务器领取确认稍后重试", error);
                }
            }
        } while (acknowledgementPending);
    };
    acknowledgementRun = run().catch((error) => { console.warn("读取领取确认队列失败", error); }).finally(() => { acknowledgementRun = undefined; });
    return acknowledgementRun;
}

function cancelUpstream(taskId?: string) {
    if (!taskId) return;
    void fetch(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST" }).catch(() => {});
}

// Use the existing async task API; polling never submits another paid request.
export async function requestImageApi(input: ImageApiInput, signal: AbortSignal, lifecycle: ImageApiLifecycle = {}) {
    signal.throwIfAborted();
    let handle = lifecycle.imageApiTask;
    if (handle) return waitForImageApiTask(handle, signal, lifecycle.onImageApiTask);
    handle = { clientRequestId: nanoid() };
    await lifecycle.onImageApiTask?.(handle);
    try {
        const { task_id: taskId } = await imageApiRequest<{ task_id: string }>(`${IMAGE_API_PATH}/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...input, client_request_id: handle.clientRequestId }),
            signal,
        });
        handle = { ...handle, taskId };
        await lifecycle.onImageApiTask?.(handle);
        return waitForImageApiTask(handle, signal, lifecycle.onImageApiTask);
    } catch (error) {
        if (signal.aborted) cancelUpstream(handle.taskId);
        throw error;
    }
}

export async function waitForImageApiTask(handle: ImageApiTaskHandle, signal: AbortSignal, onTask?: ImageApiLifecycle["onImageApiTask"]) {
    try {
        if (!handle.taskId) {
            const found = await imageApiRequest<{ task_id: string }>(`/api/v1/submissions/${encodeURIComponent(handle.clientRequestId)}`, { signal });
            handle = { ...handle, taskId: found.task_id };
            await onTask?.(handle);
        }
        while (true) {
            if (signal.aborted) {
                cancelUpstream(handle.taskId);
                signal.throwIfAborted();
            }
            const task = await imageApiRequest<ImageTask>(`/api/v1/tasks/${encodeURIComponent(handle.taskId!)}`, { signal });
            if (task.status === "cancelled") {
                throw signal.reason instanceof Error ? signal.reason : new Error("已取消");
            }
            if (task.status === "failed") {
                await onTask?.({ ...handle, failed: true });
                throw new Error(publicImageApiError(task.error) || "生成失败");
            }
            if (task.status === "completed") {
                if (task.result_released_at) throw new Error("结果已由客户端保存并从服务器释放，请在原浏览器的画布或工作台查看本地图片");
                if (!task.images.length) throw new Error("生成任务没有返回图片");
                return task.images.map((image) => {
                    const mime = image.mime_type || "image/png";
                    const dataUrl = image.base64 ? `data:${mime};base64,${image.base64}` : image.url;
                    if (!dataUrl) throw new Error("生成结果缺少图片数据");
                    return { id: nanoid(), dataUrl, ...(task.client_storage ? { imageApiTask: handle } : {}) };
                });
            }
            await new Promise<void>((resolve, reject) => {
                const abort = () => {
                    clearTimeout(timer);
                    cancelUpstream(handle.taskId);
                    reject(signal.reason);
                };
                const timer = setTimeout(() => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                }, 1500);
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
            });
        }
    } catch (error) {
        if (signal.aborted) cancelUpstream(handle.taskId);
        throw error;
    }
}
