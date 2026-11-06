import type { Asset, Picture, Mark } from "./document";
export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败，请重新导入"));
    image.src = url;
  });
}
function line(ctx: CanvasRenderingContext2D, points: number[]) {
  ctx.beginPath();
  ctx.moveTo(points[0], points[1]);
  for (let i = 2; i < points.length; i += 2)
    ctx.lineTo(points[i], points[i + 1]);
}
function drawMark(ctx: CanvasRenderingContext2D, m: Mark) {
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineWidth = m.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (m.kind === "text") {
    ctx.font = `${m.fontSize}px ${m.fontFamily || "sans-serif"}`;
    ctx.textBaseline = "top";
    ctx.fillText(m.text || "", m.points[0], m.points[1]);
    return;
  }
  line(ctx, m.points);
  ctx.stroke();
  if (m.kind === "arrow") {
    const p = m.points,
      n = p.length,
      x = p[n - 2],
      y = p[n - 1],
      a = Math.atan2(y - p[1], x - p[0]),
      size = m.width * 3 + 8;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - size * Math.cos(a - 0.45), y - size * Math.sin(a - 0.45));
    ctx.lineTo(x - size * Math.cos(a + 0.45), y - size * Math.sin(a + 0.45));
    ctx.closePath();
    ctx.fill();
  }
}
export function regionCanvas(asset: Asset, image: Picture) {
  const canvas = document.createElement("canvas");
  canvas.width = asset.width;
  canvas.height = asset.height;
  const ctx = canvas.getContext("2d")!;
  for (const r of image.regions) {
    ctx.globalCompositeOperation =
      r.kind === "erase" ? "destination-out" : "source-over";
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = r.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    line(ctx, r.points);
    if (r.kind === "lasso") {
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.stroke();
      if (r.points.length === 2) {
        ctx.beginPath();
        ctx.arc(r.points[0], r.points[1], r.width / 2, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }
  return canvas;
}
// Channel-independent selection is white/alpha; adapter emits transparent pixels to edit.
export async function exportPicture(
  asset: Asset,
  image: Picture,
  kind: "original" | "reference" | "mask",
) {
  const crop = image.crop || {
    x: 0,
    y: 0,
    width: asset.width,
    height: asset.height,
  };
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width));
  canvas.height = Math.max(1, Math.round(crop.height));
  const ctx = canvas.getContext("2d")!;
  ctx.translate(-crop.x, -crop.y);
  if (kind === "mask") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(crop.x, crop.y, crop.width, crop.height);
    ctx.globalCompositeOperation = "destination-out";
    ctx.drawImage(regionCanvas(asset, image), 0, 0);
  } else {
    ctx.drawImage(await loadImage(asset.url), 0, 0);
    if (kind === "reference") for (const m of image.marks) drawMark(ctx, m);
  }
  return canvas;
}
export function download(canvas: HTMLCanvasElement, name: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}
