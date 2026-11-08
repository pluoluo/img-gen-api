import { nanoid } from "nanoid";

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

export async function imageApiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, init);
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const detail = typeof body.detail === "string" ? body.detail : Array.isArray(body.detail) ? body.detail.map((item: { msg: string }) => item.msg).join("；") : `请求失败（${response.status}）`;
        throw new Error(detail);
    }
    return response.json();
}

type ImageApiInput = {
    sub_model: string;
    prompt: string;
    size?: string;
    n: number;
    quality?: string;
    background?: string;
    image_base64s?: string[];
    mask_base64?: string;
    preserve_outside_mask?: boolean;
};
type ImageTask = {
    status: "pending" | "running" | "completed" | "failed";
    images: { base64?: string; url?: string }[];
    error?: string;
};

export type ImageApiTaskHandle = { clientRequestId: string; taskId?: string; failed?: boolean };
export type ImageApiMask = { storageKey: string; source: { storageKey?: string; url?: string } };
export type ImageApiLifecycle = { imageApiTask?: ImageApiTaskHandle; onImageApiTask?: (handle: ImageApiTaskHandle) => Promise<void>; imageApiMask?: ImageApiMask };

// Use the existing async task API; polling never submits another paid request.
export async function requestImageApi(input: ImageApiInput, signal: AbortSignal, lifecycle: ImageApiLifecycle = {}) {
    signal.throwIfAborted();
    let handle = lifecycle.imageApiTask;
    if (handle) return waitForImageApiTask(handle, signal, lifecycle.onImageApiTask);
    handle = { clientRequestId: nanoid() };
    await lifecycle.onImageApiTask?.(handle);
    const { task_id: taskId } = await imageApiRequest<{ task_id: string }>(`${IMAGE_API_PATH}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, client_request_id: handle.clientRequestId }),
        signal,
    });
    handle = { ...handle, taskId };
    await lifecycle.onImageApiTask?.(handle);
    return waitForImageApiTask(handle, signal, lifecycle.onImageApiTask);
}

export async function waitForImageApiTask(handle: ImageApiTaskHandle, signal: AbortSignal, onTask?: ImageApiLifecycle["onImageApiTask"]) {
    if (!handle.taskId) {
        const found = await imageApiRequest<{ task_id: string }>(`/api/v1/submissions/${encodeURIComponent(handle.clientRequestId)}`, { signal });
        handle = { ...handle, taskId: found.task_id };
        await onTask?.(handle);
    }
    while (true) {
        signal.throwIfAborted();
        const task = await imageApiRequest<ImageTask>(`/api/v1/tasks/${encodeURIComponent(handle.taskId!)}`, { signal });
        if (task.status === "failed") {
            await onTask?.({ ...handle, failed: true });
            throw new Error(task.error || "生成失败");
        }
        if (task.status === "completed") {
            if (!task.images.length) throw new Error("生成任务没有返回图片");
            return task.images.map((image) => {
                const dataUrl = image.base64 ? `data:image/png;base64,${image.base64}` : image.url;
                if (!dataUrl) throw new Error("生成结果缺少图片数据");
                return { id: nanoid(), dataUrl };
            });
        }
        await new Promise<void>((resolve, reject) => {
            const abort = () => {
                clearTimeout(timer);
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
}
