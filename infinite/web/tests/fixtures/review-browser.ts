// Browser-only exports for offline regression tests; never included in the app build.
import localforage from "localforage";
import { cleanupUnusedMedia, getMediaBlob, setMediaBlob } from "../../src/services/file-storage";
import { syncAppDataToWebdav } from "../../src/services/app-sync";
import { useCanvasStore, flushCanvasStorage } from "../../src/stores/canvas/use-canvas-store";
import { useAssetStore, flushAssetStorage } from "../../src/stores/use-asset-store";
import { requestEdit } from "../../src/services/api/image";
import { defaultConfig } from "../../src/stores/use-config-store";
Object.assign(window, { infiniteReview: { localforage, cleanupUnusedMedia, getMediaBlob, setMediaBlob, syncAppDataToWebdav, useCanvasStore, useAssetStore, flushCanvasStorage, flushAssetStorage, requestEdit, defaultConfig } });
