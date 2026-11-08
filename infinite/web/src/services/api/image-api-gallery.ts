import { imageApiRequest } from "./image-api";
import { uploadImage } from "@/services/image-storage";
import { flushAssetStorage, useAssetStore } from "@/stores/use-asset-store";

export type GalleryReference = { filename: string; url: string; mime_type: string; bytes: number };
export type GalleryInputs = { references: GalleryReference[]; mask: GalleryReference | null; preserve_source: GalleryReference | null };
export type GalleryImage = { id: string; filename: string; thumb_filename?: string; image_url?: string; prompt: string; sub_model: string; created_at: string; inputs?: GalleryInputs | null };
export const galleryImageUrl = (image: GalleryImage) => (image.filename ? `/gallery/${encodeURIComponent(image.filename)}` : image.image_url || "");
export const galleryThumbnailUrl = (image: GalleryImage) => (image.thumb_filename ? `/gallery/thumb/${encodeURIComponent(image.thumb_filename)}` : galleryImageUrl(image));
export function readImageApiGallery(page: number, pageSize: number, keyword: string) {
    const query = new URLSearchParams({ limit: String(pageSize), offset: String((page - 1) * pageSize), keyword });
    return imageApiRequest<{ items: GalleryImage[]; total: number }>(`/api/v1/gallery?${query}`);
}

export async function importGalleryImage(image: GalleryImage) {
    if (!useAssetStore.getState().hydrated)
        await new Promise<void>((resolve) => {
            const unsubscribe = useAssetStore.subscribe((state) => {
                if (state.hydrated) {
                    unsubscribe();
                    resolve();
                }
            });
        });
    const existing = useAssetStore.getState().assets.find((asset) => asset.kind === "image" && asset.metadata?.galleryId === image.id);
    if (existing?.kind === "image") {
        await flushAssetStorage();
        return existing;
    }
    const stored = await uploadImage(galleryImageUrl(image));
    if (!stored.storageKey) throw new Error("原图无法下载，请确认图库文件仍然存在后重试");
    const importedWhileLoading = useAssetStore.getState().assets.find((asset) => asset.kind === "image" && asset.metadata?.galleryId === image.id);
    if (importedWhileLoading) {
        await flushAssetStorage();
        return importedWhileLoading;
    }
    const id = useAssetStore.getState().addAsset({
        kind: "image",
        title: image.prompt.slice(0, 48) || image.filename,
        tags: [],
        coverUrl: stored.url,
        source: "旧图库",
        note: image.prompt,
        metadata: { galleryId: image.id, prompt: image.prompt, model: image.sub_model, source: "image-api-gallery", inputs: image.inputs },
        data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
    });
    try {
        await flushAssetStorage();
    } catch (failure) {
        useAssetStore.getState().removeAsset(id);
        throw failure;
    }
    return useAssetStore.getState().assets.find((asset) => asset.id === id)!;
}
