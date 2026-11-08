import { importGalleryImage, type GalleryImage } from "@/services/api/image-api-gallery";
import { flushAssetStorage, useAssetStore } from "@/stores/use-asset-store";

// The legacy gallery shares the canvas stores instead of duplicating their schema.
export async function addGalleryAsset(image: GalleryImage) {
    await flushAssetStorage();
    await useAssetStore.persist.rehydrate();
    return importGalleryImage(image);
}
