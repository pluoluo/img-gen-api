import type { Asset, Document } from "./document";
import type { GenerationState } from "./GenerationPanel";
import { loadImage } from "./export";
import { request } from "./api";
export type WorkspaceSnapshot = {
  schemaVersion: 1;
  document: Document;
  assets: Record<string, Asset>;
  view: { x: number; y: number; scale: number };
  history: { past: Document[]; future: Document[] };
  selection: string[];
  generator: GenerationState;
  tools: {
    tool: string;
    color: string;
    width: number;
    fontSize: number;
    fontFamily?: string;
    text: string;
  };
};
export type Checkpoint = {
  projectId: string;
  title: string;
  revision: number;
  dirty: boolean;
  snapshot: WorkspaceSnapshot;
};
export type ProjectInfo = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  head_revision: number;
};
export type ProjectResult = ProjectInfo & {
  revision: number;
  snapshot: WorkspaceSnapshot;
};
export type RevisionInfo = {
  revision: number;
  created_at: string;
  image_count: number;
};
let dbPromise: Promise<IDBDatabase> | undefined;
function database() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("image-api-canvas", 1);
    open.onupgradeneeded = () => {
      for (const name of ["assets", "workspaces", "meta"])
        open.result.createObjectStore(name);
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () =>
      reject(open.error || new Error("无法打开本地画布备份"));
  }));
}
async function read<T>(store: string, key: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, "readonly"),
      req = transaction.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function write(store: string, key: string, value: unknown) {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, "readwrite");
    transaction.objectStore(store).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () =>
      reject(transaction.error || new Error("本地存储空间不足"));
  });
}
type LocalAsset = { blob: Blob; remoteUrl?: string };
const assetWork = new Map<string, Promise<LocalAsset>>();
async function assetRecord(asset: Asset): Promise<LocalAsset> {
  let pending = assetWork.get(asset.id);
  if (!pending) {
    pending = (async () => {
      const stored = await read<LocalAsset>("assets", asset.id);
      if (stored) return stored;
      const image = await loadImage(asset.url),
        canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      canvas.getContext("2d")!.drawImage(image, 0, 0);
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) =>
            value ? resolve(value) : reject(new Error("无法保存图片资源")),
          "image/png",
        ),
      );
      const record = {
        blob,
        ...(asset.url.startsWith("/api/v1/canvas/assets/")
          ? { remoteUrl: asset.url }
          : {}),
      };
      await write("assets", asset.id, record);
      return record;
    })();
    assetWork.set(asset.id, pending);
    pending.catch(() => assetWork.delete(asset.id));
  }
  return pending;
}
export function validateSnapshot(value: WorkspaceSnapshot) {
  if (
    value?.schemaVersion !== 1 ||
    value.document?.schemaVersion !== 1 ||
    !Array.isArray(value.document.images) ||
    !value.assets ||
    !value.history ||
    !Array.isArray(value.history.past) ||
    !Array.isArray(value.history.future) ||
    !Array.isArray(value.selection) ||
    !value.tools ||
    !value.generator ||
    !Array.isArray(value.generator.jobs) ||
    !Array.isArray(value.generator.refs) ||
    !value.view ||
    !Number.isFinite(value.view.x) ||
    !Number.isFinite(value.view.y) ||
    !Number.isFinite(value.view.scale) ||
    value.view.scale <= 0
  )
    throw new Error("画布版本不兼容或内容损坏，未覆盖现有工作区");
  const images = [
    ...value.document.images,
    ...value.history.past.flatMap((d) => d.images),
    ...value.history.future.flatMap((d) => d.images),
    ...value.generator.jobs.flatMap((j) => j.snapshot.pictures),
  ];
  if (images.some((p) => !value.assets[p.assetId]))
    throw new Error("历史画布缺少图片资源，未覆盖现有工作区");
}
export function signature(snapshot: WorkspaceSnapshot, title: string) {
  return (
    JSON.stringify({
      ...snapshot,
      assets: Object.fromEntries(
        Object.entries(snapshot.assets).map(([key, value]) => [
          key,
          { ...value, url: "asset:" + key },
        ]),
      ),
    }) +
    "\n" +
    title
  );
}
export async function backup(checkpoint: Checkpoint) {
  await Promise.all(Object.values(checkpoint.snapshot.assets).map(assetRecord));
  await write("workspaces", checkpoint.projectId, checkpoint);
  await write("meta", "active", checkpoint.projectId);
}
export async function readActive(): Promise<Checkpoint | undefined> {
  const active = await read<string>("meta", "active");
  return active ? read<Checkpoint>("workspaces", active) : undefined;
}
export async function restoreAssets(
  snapshot: WorkspaceSnapshot,
): Promise<WorkspaceSnapshot> {
  validateSnapshot(snapshot);
  const assets: Record<string, Asset> = {};
  for (const asset of Object.values(snapshot.assets)) {
    const stored = await read<LocalAsset>("assets", asset.id);
    if (stored)
      assets[asset.id] = { ...asset, url: URL.createObjectURL(stored.blob) };
    else if (asset.url.startsWith("/api/v1/canvas/assets/"))
      assets[asset.id] = asset;
    else throw new Error("本地图片备份缺失，请从服务器历史重新打开画布");
  }
  return { ...snapshot, assets };
}
export async function uploadAssets(
  snapshot: WorkspaceSnapshot,
): Promise<WorkspaceSnapshot> {
  const assets: Record<string, Asset> = {};
  for (const asset of Object.values(snapshot.assets)) {
    if (asset.url.startsWith("/api/v1/canvas/assets/")) {
      assets[asset.id] = asset;
      continue;
    }
    const stored = await assetRecord(asset);
    if (!stored.remoteUrl) {
      const form = new FormData();
      form.append("file", stored.blob, "canvas.png");
      const result = await request<{
        url: string;
        width: number;
        height: number;
      }>("/canvas/assets", { method: "POST", body: form });
      if (result.width !== asset.width || result.height !== asset.height)
        throw new Error("图片保存尺寸与画布资源不一致");
      stored.remoteUrl = result.url;
      await write("assets", asset.id, stored);
    }
    assets[asset.id] = { ...asset, url: stored.remoteUrl };
  }
  return { ...snapshot, assets };
}
export const getProject = (projectId: string, revision?: number) =>
  request<ProjectResult>(
    "/canvas/projects/" +
      encodeURIComponent(projectId) +
      (revision ? "?revision=" + revision : ""),
  );
export const getProjects = (offset = 0) =>
  request<{ items: ProjectInfo[]; total: number }>(
    "/canvas/projects?limit=50&offset=" + offset,
  );
export const getRevisions = (projectId: string, offset = 0) =>
  request<{ items: RevisionInfo[]; total: number }>(
    "/canvas/projects/" +
      encodeURIComponent(projectId) +
      "/revisions?limit=50&offset=" +
      offset,
  );
export const saveProject = (
  projectId: string,
  title: string,
  snapshot: WorkspaceSnapshot,
  revision: number,
) =>
  request<{ id: string; title: string; revision: number; updated_at: string }>(
    "/canvas/projects/" + encodeURIComponent(projectId),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, snapshot, base_revision: revision }),
    },
  );
