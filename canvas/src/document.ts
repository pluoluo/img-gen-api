export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type Mark = {
  id: string;
  kind: "pen" | "arrow" | "text";
  points: number[];
  color: string;
  width: number;
  text?: string;
  fontSize: number;
  fontFamily?: string;
};
export type Region = {
  id: string;
  kind: "brush" | "lasso" | "erase";
  points: number[];
  width: number;
};
export type Asset = {
  id: string;
  url: string;
  width: number;
  height: number;
  name: string;
};
export type Picture = {
  id: string;
  assetId: string;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  crop?: Rect;
  marks: Mark[];
  regions: Region[];
  source?: { jobId: string; taskId: string; parentIds: string[] };
};
export type Document = { schemaVersion: 1; images: Picture[] };
export function id(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  // LAN HTTP origins do not expose randomUUID; getRandomValues still works.
  // Keep UUID v4 identifiers for assets, history and idempotent submissions.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function localPoint(p: Point, image: Picture): Point {
  const a = (-image.rotation * Math.PI) / 180,
    dx = p.x - image.x,
    dy = p.y - image.y;
  return {
    x: (dx * Math.cos(a) - dy * Math.sin(a)) / image.scaleX,
    y: (dx * Math.sin(a) + dy * Math.cos(a)) / image.scaleY,
  };
}
export function worldPoint(p: Point, image: Picture): Point {
  const a = (image.rotation * Math.PI) / 180,
    x = p.x * image.scaleX,
    y = p.y * image.scaleY;
  return {
    x: image.x + x * Math.cos(a) - y * Math.sin(a),
    y: image.y + x * Math.sin(a) + y * Math.cos(a),
  };
}
export function zoomAt(
  view: { x: number; y: number; scale: number },
  p: Point,
  scale: number,
) {
  scale = Math.max(0.03, Math.min(8, scale));
  return {
    x: p.x - ((p.x - view.x) / view.scale) * scale,
    y: p.y - ((p.y - view.y) / view.scale) * scale,
    scale,
  };
}
export function cropRect(a: Point, b: Point, asset: Asset): Rect {
  const x = Math.max(0, Math.min(asset.width, Math.min(a.x, b.x))),
    y = Math.max(0, Math.min(asset.height, Math.min(a.y, b.y)));
  return {
    x,
    y,
    width: Math.max(0, Math.min(asset.width, Math.max(a.x, b.x)) - x),
    height: Math.max(0, Math.min(asset.height, Math.max(a.y, b.y)) - y),
  };
}
export class History {
  past: Document[] = [];
  future: Document[] = [];
  commit(before: Document) {
    this.past.push(structuredClone(before));
    if (this.past.length > 80) this.past.shift();
    this.future = [];
  }
  undo(current: Document) {
    const next = this.past.pop();
    if (next) this.future.push(structuredClone(current));
    return next;
  }
  redo(current: Document) {
    const next = this.future.pop();
    if (next) this.past.push(structuredClone(current));
    return next;
  }
}
