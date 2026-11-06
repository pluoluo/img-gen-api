import { test, expect, Page } from "@playwright/test";
async function image(page: Page) {
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 420;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#31586b";
    ctx.fillRect(0, 0, 640, 420);
    ctx.fillStyle = "#dbb782";
    ctx.fillRect(160, 80, 240, 260);
    return c.toDataURL().split(",")[1];
  });
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "浮动工具测试.png",
      mimeType: "image/png",
      buffer: Buffer.from(data, "base64"),
    });
  await expect(page.locator(".status-message")).toContainText(
    "已导入 1 张图片",
  );
}
test("floating canvas tools and contextual image actions preserve the sidebar", async ({
  page,
}, info) => {
  await page.goto("/canvas/");
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
  const dock = page.getByRole("navigation", { name: "画布工具" });
  await expect(dock).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "选中图片操作" })).toHaveCount(
    0,
  );
  await image(page);
  const bar = page.getByRole("toolbar", { name: "选中图片操作" });
  await expect(bar).toBeVisible();
  const geometry = await page.evaluate(() => {
    const stage = document
      .querySelector(".stage-host")!
      .getBoundingClientRect();
    const dock = document
      .querySelector(".canvas-dock")!
      .getBoundingClientRect();
    const right = document
      .querySelector(".right-sidebar")!
      .getBoundingClientRect();
    const bar = document
      .querySelector(".image-toolbar")!
      .getBoundingClientRect();
    return {
      stage: { x: stage.x, right: stage.right, bottom: stage.bottom },
      dock: { x: dock.x, bottom: dock.bottom },
      right: right.x,
      bar: { right: bar.right },
    };
  });
  expect(geometry.stage.x).toBe(0);
  expect(geometry.stage.right).toBeCloseTo(geometry.right, 0);
  expect(geometry.dock.x).toBeGreaterThan(geometry.stage.x);
  expect(geometry.dock.bottom).toBeLessThan(geometry.stage.bottom);
  expect(geometry.bar.right).toBeLessThanOrEqual(geometry.stage.right);
  await bar.getByRole("button", { name: "将选中图片设为生成参考" }).click();
  await expect(page.locator(".generation-inputs ol")).toContainText(
    "浮动工具测试.png",
  );
  await bar.getByRole("button", { name: "标注图片", exact: true }).click();
  await expect(
    dock.getByRole("button", { name: "画笔标记", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(bar).toBeHidden();
  await expect(page.getByLabel("标注颜色", { exact: true })).toBeVisible();
  await dock.getByRole("button", { name: "选择", exact: true }).click();
  await expect(bar).toBeVisible();
  await bar.getByRole("button", { name: "聚焦选中图片" }).click();
  await expect
    .poll(async () => {
      const b = await bar.boundingBox();
      return b!.x >= 0 && b!.y >= 56;
    })
    .toBeTruthy();
  const download = page.waitForEvent("download");
  await bar.getByRole("button", { name: "导出含标注图片" }).click();
  expect((await download).suggestedFilename()).toContain("reference.png");
  await bar.getByRole("button", { name: "复制选中图片" }).click();
  await expect(
    page.getByLabel("当前图片", { exact: true }).locator("option"),
  ).toHaveCount(3);
  await page.screenshot({
    path: info.outputPath("floating-tools-desktop.png"),
    animations: "disabled",
  });
  const host = await page.locator(".stage-host").boundingBox();
  await page.mouse.click(host!.x + host!.width - 12, host!.y + 12);
  await expect(bar).toHaveCount(0);
});
test("floating tools remain inside the canvas on a narrow screen", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/canvas/");
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
  await image(page);
  const dock = page.getByRole("navigation", { name: "画布工具" });
  await expect(dock).toBeVisible();
  await dock.getByRole("button", { name: "擦除区域", exact: true }).click();
  await expect(
    dock.getByRole("button", { name: "擦除区域", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await dock.getByRole("button", { name: "选择", exact: true }).click();
  const bar = page.getByRole("toolbar", { name: "选中图片操作" });
  await expect(bar).toBeVisible();
  for (const item of [dock, bar]) {
    const r = await item.boundingBox();
    expect(r!.x).toBeGreaterThanOrEqual(0);
    expect(r!.x + r!.width).toBeLessThanOrEqual(390);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.screenshot({
    path: info.outputPath("floating-tools-mobile.png"),
    animations: "disabled",
  });
});

test("contextual dock parameters edit real marks and persist fonts through reload", async ({
  page,
}, info) => {
  await page.goto("/canvas/");
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
  await image(page);
  const dock = page.getByRole("navigation", { name: "画布工具" });
  await dock.getByRole("button", { name: "文字", exact: true }).click();
  const parameters = dock.getByRole("region", { name: "工具快捷参数" });
  await expect(parameters).toBeVisible();
  await parameters.getByLabel("字体", { exact: true }).selectOption("serif");
  await parameters.getByLabel("字号", { exact: true }).fill("48");
  await parameters.getByLabel("标注颜色", { exact: true }).fill("#56cfa1");
  await parameters.getByLabel("文字内容", { exact: true }).fill("画布字体 Aa");
  const host = await page.locator(".stage-host").boundingBox();
  await page.mouse.click(host!.x + 130, host!.y + 130);
  await expect(page.locator(".marks")).toContainText("画布字体 Aa");
  await page.getByRole("button", { name: "编辑标注 画布字体 Aa" }).click();
  await parameters
    .getByLabel("字体", { exact: true })
    .selectOption("monospace");
  await parameters.getByLabel("字号", { exact: true }).fill("52");
  await parameters.getByRole("button", { name: "应用属性到标注" }).click();
  await page.screenshot({
    path: info.outputPath("text-parameters-desktop.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "历史画布", exact: true }).click();
  await page.getByLabel("画布名称", { exact: true }).fill("工具字体恢复验证");
  await page.getByRole("button", { name: "保存当前版本", exact: true }).click();
  await expect(page.locator(".project-save-state")).toContainText("已保存");
  const projects = await (
    await page.request.get("/api/v1/canvas/projects?limit=200")
  ).json();
  const project = projects.items.find(
    (p: any) => p.title === "工具字体恢复验证",
  );
  const saved = await (
    await page.request.get("/api/v1/canvas/projects/" + project.id)
  ).json();
  expect(saved.snapshot.document.images[0].marks[0]).toMatchObject({
    fontFamily: "monospace",
    fontSize: 52,
    color: "#56cfa1",
    text: "画布字体 Aa",
  });
  expect(saved.snapshot.tools.fontFamily).toBe("monospace");
  await page.reload();
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
  await expect(parameters.getByLabel("字体", { exact: true })).toHaveValue(
    "monospace",
  );
  await expect(parameters.getByLabel("字号", { exact: true })).toHaveValue(
    "52",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(parameters).toBeVisible();
  const bounds = await parameters.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  const exportImage = page.waitForEvent("download");
  // The export action is available on the contextual image strip in selection mode.
  await dock.getByRole("button", { name: "选择", exact: true }).click();
  await page.getByRole("button", { name: "导出含标注图片" }).click();
  expect((await exportImage).suggestedFilename()).toContain("reference.png");
  await dock.getByRole("button", { name: "画笔标记", exact: true }).click();
  await expect(parameters.getByLabel("字体", { exact: true })).toHaveCount(0);
  await expect(
    parameters.getByLabel("画笔宽度（原图像素）", { exact: true }),
  ).toBeVisible();
  await parameters
    .getByLabel("画笔宽度（原图像素）", { exact: true })
    .fill("25");
  await dock.getByRole("button", { name: "文字", exact: true }).click();
  await expect(parameters.getByLabel("字体", { exact: true })).toHaveValue(
    "monospace",
  );
  await page.screenshot({
    path: info.outputPath("text-parameters-mobile.png"),
    animations: "disabled",
  });
});
