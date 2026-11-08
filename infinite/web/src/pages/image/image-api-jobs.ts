import localforage from "localforage";
import { nanoid } from "nanoid";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { waitForImageApiTask, type ImageApiTaskHandle } from "@/services/api/image-api";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type WorkbenchImage = { id: string; dataUrl: string; storageKey?: string; durationMs: number; width: number; height: number; bytes: number; mimeType?: string };
export type WorkbenchSnapshot = { text: string; config: AiConfig; references: ReferenceImage[] };
export type WorkbenchJob = {
    id: string;
    batchId: string;
    createdAt: number;
    index: number;
    prompt: string;
    config: Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count" | "background">;
    references: ReferenceImage[];
    task?: ImageApiTaskHandle;
    image?: WorkbenchImage;
    error?: string;
};
export const workbenchJobs = localforage.createInstance({ name: "infinite-canvas", storeName: "image_api_workbench_jobs" });
const activeJobs = new Map<string, Promise<WorkbenchImage>>();

export function createWorkbenchJob(snapshot: WorkbenchSnapshot, batchId: string, index: number, count: number): WorkbenchJob {
    const { model, quality, size, background } = snapshot.config;
    return {
        id: nanoid(),
        batchId,
        index,
        createdAt: Date.now(),
        prompt: snapshot.text,
        config: { model, imageModel: model, quality, size, background, count: String(count) },
        references: snapshot.references.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
    };
}

export async function readWorkbenchJobs() {
    const jobs: WorkbenchJob[] = [];
    await workbenchJobs.iterate<WorkbenchJob, void>((job) => {
        jobs.push(job);
    });
    return jobs.sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);
}

export function runWorkbenchJob(job: WorkbenchJob, snapshot?: WorkbenchSnapshot) {
    const active = activeJobs.get(job.id);
    if (active) return active;
    const run = async () => {
        try {
            if (job.image) {
                const dataUrl = await resolveImageUrl(job.image.storageKey, job.image.dataUrl).catch(() => "");
                if (dataUrl) return { ...job.image, dataUrl };
                job.image = undefined;
            }
            const startedAt = performance.now();
            const onImageApiTask = async (task: ImageApiTaskHandle) => {
                job.task = task;
                // This write is awaited before POST, including the request identity.
                await workbenchJobs.setItem(job.id, job);
            };
            const result = job.task
                ? await waitForImageApiTask(job.task, new AbortController().signal, onImageApiTask)
                : snapshot
                  ? snapshot.references.length
                      ? await requestEdit(snapshot.config, snapshot.text, snapshot.references, { onImageApiTask })
                      : await requestGeneration(snapshot.config, snapshot.text, { onImageApiTask })
                  : (() => {
                        throw new Error("未找到原任务，未自动重新提交");
                    })();
            if (!result[0]) throw new Error("生成任务没有返回图片");
            const stored = await uploadImage(result[0].dataUrl);
            const image: WorkbenchImage = { id: job.id, dataUrl: stored.url, storageKey: stored.storageKey, durationMs: performance.now() - startedAt, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
            job.image = { ...image, dataUrl: image.storageKey ? "" : image.dataUrl };
            job.error = undefined;
            if (job.task) await workbenchJobs.setItem(job.id, job);
            return image;
        } catch (error) {
            job.error = error instanceof Error ? error.message : String(error);
            if (job.task) await workbenchJobs.setItem(job.id, job);
            throw error;
        }
    };
    const promise = run();
    activeJobs.set(job.id, promise);
    void promise.finally(() => activeJobs.delete(job.id)).catch(() => undefined);
    return promise;
}
