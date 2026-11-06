import { readFileSync } from "node:fs";
import { test, expect } from "@playwright/test";
async function fixture(page: any) {
  await page.goto("/canvas/");
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    const x = c.getContext("2d")!;
    x.fillStyle = "#235680";
    x.fillRect(0, 0, 400, 300);
    x.fillStyle = "#ebbe54";
    x.fillRect(40, 40, 100, 100);
    return c.toDataURL().split(",")[1];
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "fixture.png",
    mimeType: "image/png",
    buffer: Buffer.from(data, "base64"),
  });
  await expect(
    page.getByRole("heading", { name: "fixture.png" }),
  ).toBeVisible();
  return page.locator(".stage-host").boundingBox();
}
test("coordinate roundtrip, viewport invariance, history and exact mask pixels", async ({
  page,
}, info) => {
  await page.goto("/canvas/");
  const result = await page.evaluate(async () => {
    const { localPoint, worldPoint, zoomAt, History } = await import(
      "/canvas/src/document.ts"
    );
    const { exportPicture } = await import("/canvas/src/export.ts");
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#235680";
    ctx.fillRect(0, 0, 400, 300);
    const asset = {
      id: "a",
      url: canvas.toDataURL(),
      width: 400,
      height: 300,
      name: "test",
    };
    const image = {
      id: "i",
      assetId: "a",
      x: 327,
      y: -155,
      scaleX: 1.7,
      scaleY: 0.6,
      rotation: 37,
      marks: [
        {
          id: "m",
          kind: "text" as const,
          points: [30, 30],
          text: "中文",
          color: "#ff0000",
          width: 4,
          fontSize: 30,
        },
      ],
      regions: [
        {
          id: "r",
          kind: "lasso" as const,
          points: [100, 100, 200, 100, 200, 200, 100, 200],
          width: 12,
        },
      ],
    };
    const p = { x: 123, y: 154 },
      back = localPoint(worldPoint(p, image), image);
    const v = { x: 31, y: 72, scale: 0.5 },
      pointer = { x: 411, y: 311 },
      z = zoomAt(v, pointer, 2);
    const mask = await exportPicture(asset, image, "mask"),
      reference = await exportPicture(asset, image, "reference"),
      original = await exportPicture(asset, image, "original");
    const read = (c: HTMLCanvasElement, x: number, y: number) =>
      Array.from(c.getContext("2d")!.getImageData(x, y, 1, 1).data);
    const cropped = await exportPicture(
      asset,
      { ...image, crop: { x: 80, y: 70, width: 180, height: 170 } },
      "mask",
    );
    const h = new History(),
      d = { schemaVersion: 1 as const, images: [] };
    h.commit(d);
    const next = { schemaVersion: 1 as const, images: [image] };
    const undone = h.undo(next),
      redone = h.redo(d);
    return {
      back,
      anchor: [(pointer.x - z.x) / z.scale, (pointer.y - z.y) / z.scale],
      expectedAnchor: [
        (pointer.x - v.x) / v.scale,
        (pointer.y - v.y) / v.scale,
      ],
      maskSize: [mask.width, mask.height],
      inside: read(mask, 150, 150),
      outside: read(mask, 20, 20),
      originalPixel: read(original, 20, 20),
      cropSize: [cropped.width, cropped.height],
      cropInside: read(cropped, 70, 80),
      cropOutside: read(cropped, 0, 0),
      undo: undone?.images.length,
      redo: redone?.images.length,
      mask: mask.toDataURL(),
      reference: reference.toDataURL(),
    };
  });
  expect(result.back.x).toBeCloseTo(123);
  expect(result.back.y).toBeCloseTo(154);
  expect(result.anchor).toEqual(result.expectedAnchor);
  expect(result.maskSize).toEqual([400, 300]);
  expect(result.inside[3]).toBe(0);
  expect(result.outside).toEqual([255, 255, 255, 255]);
  expect(result.originalPixel).toEqual([35, 86, 128, 255]);
  expect(result.cropSize).toEqual([180, 170]);
  expect(result.cropInside[3]).toBe(0);
  expect(result.cropOutside[3]).toBe(255);
  expect(result.undo).toBe(0);
  expect(result.redo).toBe(1);
  await info.attach("mask.png", {
    body: Buffer.from(result.mask.split(",")[1], "base64"),
    contentType: "image/png",
  });
  await info.attach("reference.png", {
    body: Buffer.from(result.reference.split(",")[1], "base64"),
    contentType: "image/png",
  });
});
test("import, Chinese annotation, pointer zoom, pan, movement, crop, region and export", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const box = await fixture(page);
  if (!box) throw Error("missing canvas");
  const at = (x: number, y: number) => ({
    x: box.x + 50 + x * 0.8,
    y: box.y + 50 + y * 0.8,
  });
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.getByLabel("文字内容", { exact: true }).fill("中文输入验证");
  await page.mouse.click(at(50, 40).x, at(50, 40).y);
  await expect(page.locator(".marks")).toContainText("中文输入验证");
  await page.getByRole("button", { name: "箭头", exact: true }).click();
  await page.mouse.move(at(40, 100).x, at(40, 100).y);
  await page.mouse.down();
  await page.mouse.move(at(180, 150).x, at(180, 150).y, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".marks")).toContainText("箭头");
  await page.getByRole("button", { name: "画笔标记", exact: true }).click();
  await page.mouse.move(at(60, 180).x, at(60, 180).y);
  await page.mouse.down();
  await page.mouse.move(at(190, 220).x, at(190, 220).y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(".marks>div")).toHaveCount(3);
  // Keyboard shortcuts must not consume text input.
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.getByLabel("文字内容", { exact: true }).focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("draft");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".marks>div")).toHaveCount(3);
  await page.getByRole("button", { name: "圈选区域", exact: true }).click();
  await page.mouse.move(at(100, 100).x, at(100, 100).y);
  await page.mouse.down();
  for (const [x, y] of [
    [200, 100],
    [200, 200],
    [100, 200],
    [100, 100],
  ])
    await page.mouse.move(at(x, y).x, at(x, y).y, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByRole("heading", { name: /修改区域 1/ })).toBeVisible();
  await page.getByText("导出图片与蒙版", { exact: true }).click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "独立 PNG mask" }).click();
  await (await dl).saveAs(info.outputPath("ui-mask.png"));
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await page.mouse.move(at(250, 220).x, at(250, 220).y);
  await page.mouse.down();
  await page.mouse.move(at(250, 220).x + 90, at(250, 220).y + 50, { steps: 8 });
  await page.mouse.up();
  await page.getByLabel("旋转角度").fill("25");
  await page.getByLabel("旋转角度").blur();
  await page.mouse.move(box.x + 300, box.y + 230);
  await page.mouse.wheel(0, -200);
  await expect(page.locator("header output")).not.toHaveText("80%");
  await page.keyboard.down("Space");
  await page.mouse.move(box.x + 600, box.y + 400);
  await page.mouse.down();
  await page.mouse.move(box.x + 660, box.y + 440, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  await expect(page.locator(".marks>div")).toHaveCount(3);
  await page.getByRole("button", { name: "适配内容" }).click();
  await page.screenshot({ path: info.outputPath("desktop.png") });
  const afterDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "独立 PNG mask" }).click();
  await (await afterDownload).saveAs(info.outputPath("transformed-mask.png"));
  expect(readFileSync(info.outputPath("transformed-mask.png"))).toEqual(
    readFileSync(info.outputPath("ui-mask.png")),
  );
  expect(errors).toEqual([]);
});
test("mobile empty state remains usable", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/canvas/");
  await expect(page.getByText("窄屏可浏览与导入图片")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "选择图片", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("mobile.png") });
});

test("crop, brush, erase, annotation editing and grouped undo redo", async ({
  page,
}) => {
  const box = await fixture(page);
  if (!box) throw Error("canvas");
  const at = (x: number, y: number) => ({
    x: box.x + 50 + x * 0.8,
    y: box.y + 50 + y * 0.8,
  });
  await page.getByRole("button", { name: "裁剪", exact: true }).click();
  await page.mouse.move(at(40, 30).x, at(40, 30).y);
  await page.mouse.down();
  await page.mouse.move(at(340, 260).x, at(340, 260).y, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "恢复裁剪" })).toBeEnabled();
  await page.getByText("导出图片与蒙版", { exact: true }).click();
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "原图 / 裁剪图" }).click();
  const dl = await event;
  const stream = await dl.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const b64 = Buffer.concat(chunks).toString("base64");
  const dims = await page.evaluate(async (b64) => {
    const i = new Image();
    i.src = "data:image/png;base64," + b64;
    await i.decode();
    return [i.width, i.height];
  }, b64);
  expect(dims).toEqual([300, 230]);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复裁剪" })).toBeDisabled();
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(page.getByRole("button", { name: "恢复裁剪" })).toBeEnabled();
  await page.getByRole("button", { name: "涂抹区域", exact: true }).click();
  await page.mouse.move(at(100, 100).x, at(100, 100).y);
  await page.mouse.down();
  await page.mouse.move(at(200, 180).x, at(200, 180).y, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByRole("heading", { name: /修改区域 1/ })).toBeVisible();
  await page.getByRole("button", { name: "擦除区域", exact: true }).click();
  await page.mouse.move(at(150, 130).x, at(150, 130).y);
  await page.mouse.down();
  await page.mouse.move(at(160, 140).x, at(160, 140).y);
  await page.mouse.up();
  await expect(page.getByRole("heading", { name: /修改区域 2/ })).toBeVisible();
  await page.getByRole("button", { name: "清空修改区域" }).click();
  await expect(page.getByRole("heading", { name: /修改区域 0/ })).toBeVisible();
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByRole("heading", { name: /修改区域 2/ })).toBeVisible();
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.mouse.click(at(100, 50).x, at(100, 50).y);
  await page.getByRole("button", { name: "编辑标注 中文标注" }).click();
  await page.getByLabel("文字内容", { exact: true }).fill("编辑后的中文");
  await page.getByRole("button", { name: "应用属性到标注" }).click();
  await expect(page.locator(".marks")).toContainText("编辑后的中文");
  await page.getByRole("button", { name: "删除标注", exact: true }).click();
  await expect(page.locator(".marks>div")).toHaveCount(0);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.locator(".marks")).toContainText("编辑后的中文");
});

test("drop, clipboard, gallery, multi select, duplicate, delete and shortcuts", async ({
  page,
}) => {
  const box = await fixture(page);
  if (!box) throw Error("canvas");
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    return c.toDataURL();
  });
  await page.locator(".stage-host").evaluate(async (el, url) => {
    const blob = await (await fetch(url)).blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "drop.png", { type: "image/png" }));
    el.dispatchEvent(
      new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
    );
  }, data);
  await expect(page.getByRole("heading", { name: "drop.png" })).toBeVisible();
  await page.locator(".stage-host").focus();
  await page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob();
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "paste.png", { type: "image/png" }));
    window.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }),
    );
  }, data);
  await expect(page.getByRole("heading", { name: "paste.png" })).toBeVisible();
  await page.route("**/api/v1/gallery?*", (r) =>
    r.fulfill({
      json: {
        items: [{ id: "g", filename: "fixture.png", prompt: "图库测试" }],
        total: 1,
      },
    }),
  );
  await page.route("**/gallery/fixture.png", (r) =>
    r.fulfill({
      contentType: "image/png",
      body: Buffer.from(data.split(",")[1], "base64"),
    }),
  );
  await page.getByRole("button", { name: "从图库插入" }).click();
  await page
    .getByRole("region", { name: "选择图库图片" })
    .getByRole("button", { name: /插入画布/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "插入图片.png" }),
  ).toBeVisible();
  await page.locator(".stage-host").focus();
  await page.keyboard.press("Control+a");
  await expect(
    page.getByText("已选中 4 张图片", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Control+d");
  await page.keyboard.press("Control+a");
  await expect(
    page.getByText("已选中 8 张图片", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Delete");
  await expect(
    page.getByRole("heading", { name: "从一张图片开始" }),
  ).toBeVisible();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+a");
  await expect(
    page.getByText("已选中 8 张图片", { exact: true }),
  ).toBeVisible();
});

test("multi-image drag and resize commit one history step", async ({
  page,
}) => {
  const box = await fixture(page);
  if (!box) throw Error("canvas");
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 400, 300);
    return c.toDataURL().split(",")[1];
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "second.png",
    mimeType: "image/png",
    buffer: Buffer.from(data, "base64"),
  });
  await expect(page.getByRole("heading", { name: "second.png" })).toBeVisible();
  await page
    .getByLabel("当前图片", { exact: true })
    .selectOption({ label: "fixture.png" });
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + 200, box.y + 180);
  await page.keyboard.up("Shift");
  await expect(
    page.getByText("已选中 2 张图片", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("图片位置")).toHaveText("X 0 · Y 0");
  await page.mouse.move(box.x + 200, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 280, box.y + 220, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByLabel("图片位置")).toHaveText("X 100 · Y 50");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByLabel("图片位置")).toHaveText("X 0 · Y 0");
  await page.mouse.move(box.x + 370, box.y + 290);
  await page.mouse.down();
  await page.mouse.move(box.x + 450, box.y + 350, { steps: 10 });
  await page.mouse.up();
  await expect(page.getByLabel("图片缩放")).not.toHaveText("缩放 1.00 × 1.00");
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByLabel("图片缩放")).toHaveText("缩放 1.00 × 1.00");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(page.getByLabel("图片缩放")).not.toHaveText("缩放 1.00 × 1.00");
});

test("text exports use the selected font and preserve old marks without a font", async ({
  page,
}) => {
  await page.goto("/canvas/");
  const result = await page.evaluate(async () => {
    const { exportPicture } = await import("/canvas/src/export.ts");
    const source = document.createElement("canvas");
    source.width = 400;
    source.height = 160;
    const ctx = source.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 400, 160);
    const asset = {
      id: "font-asset",
      url: source.toDataURL(),
      width: 400,
      height: 160,
      name: "font.png",
    };
    const mark = {
      id: "font-mark",
      kind: "text" as const,
      text: "Wiiii Aa 012",
      points: [20, 20],
      color: "#000000",
      width: 1,
      fontSize: 44,
    };
    const doc = {
      id: "font-image",
      assetId: asset.id,
      x: 0,
      y: 0,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      marks: [mark],
      regions: [],
    };
    const old = await exportPicture(asset, doc, "reference");
    const sans = await exportPicture(
      asset,
      { ...doc, marks: [{ ...mark, fontFamily: "sans-serif" }] },
      "reference",
    );
    const mono = await exportPicture(
      asset,
      { ...doc, marks: [{ ...mark, fontFamily: "monospace" }] },
      "reference",
    );
    return {
      fallbackMatches: old.toDataURL() === sans.toDataURL(),
      fontsDiffer: sans.toDataURL() !== mono.toDataURL(),
      width: mono.width,
      height: mono.height,
    };
  });
  expect(result).toEqual({
    fallbackMatches: true,
    fontsDiffer: true,
    width: 400,
    height: 160,
  });
});
