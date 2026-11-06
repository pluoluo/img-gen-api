import { test, expect } from "@playwright/test";

test("right-hand composer supports long prompts and tool-specific parameters", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1440, height: 912 });
  await page.goto("/canvas/");
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 600;
    c.height = 400;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#235680";
    ctx.fillRect(0, 0, 600, 400);
    ctx.fillStyle = "#ebbe54";
    ctx.fillRect(80, 80, 180, 180);
    return c.toDataURL().split(",")[1];
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "构图参考.png",
    mimeType: "image/png",
    buffer: Buffer.from(data, "base64"),
  });
  await expect(
    page.getByRole("heading", { name: "构图参考.png" }),
  ).toBeVisible();
  const prompt = page.getByLabel("生成描述", { exact: true }),
    sidebar = page.getByRole("complementary", { name: "工具与生成面板" });
  const longPrompt = "保留主体构图，使用自然光与细腻的材质。\n".repeat(180);
  await prompt.fill(longPrompt);
  const geometry = await prompt.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      panel = el.closest("aside")!.getBoundingClientRect(),
      stage = document.querySelector(".stage-host")!.getBoundingClientRect();
    return {
      x: r.x,
      width: r.width,
      height: r.height,
      panelX: panel.x,
      panelWidth: panel.width,
      stageRight: stage.right,
      stageHeight: stage.height,
      viewportHeight: innerHeight,
      resize: getComputedStyle(el).resize,
    };
  });
  expect(geometry.panelX).toBeCloseTo(geometry.stageRight, 0);
  expect(geometry.x).toBeGreaterThan(geometry.panelX);
  expect(geometry.width).toBeLessThan(geometry.panelWidth);
  expect(geometry.height).toBeGreaterThanOrEqual(180);
  expect(geometry.stageHeight).toBeGreaterThan(geometry.viewportHeight * 0.8);
  expect(geometry.resize).toBe("vertical");
  await expect(page.locator(".generation-footer")).toHaveCount(0);
  await expect(page.getByLabel("文字内容", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("标注颜色", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await expect(page.getByLabel("文字内容", { exact: true })).toBeVisible();
  await expect(page.getByLabel("字号", { exact: true })).toBeVisible();
  await expect(page.getByLabel("标注颜色", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("画笔宽度（原图像素）", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "画笔标记", exact: true }).click();
  await expect(page.getByLabel("标注颜色", { exact: true })).toBeVisible();
  await expect(
    page.getByLabel("画笔宽度（原图像素）", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("文字内容", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("字号", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "涂抹区域", exact: true }).click();
  await expect(
    page.getByLabel("画笔宽度（原图像素）", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("标注颜色", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "裁剪", exact: true }).click();
  await expect(
    page.getByLabel("画笔宽度（原图像素）", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "恢复裁剪" })).toBeVisible();
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page
    .getByRole("button", { name: "选中图片作为参考", exact: true })
    .click();
  await expect(sidebar.getByAltText("参考图预览")).toBeVisible();
  await expect(prompt).toHaveValue(longPrompt);
  const visibleHeight = await prompt.evaluate((el) => {
    const r = el.getBoundingClientRect(),
      scroll = el.closest(".composer-scroll")!.getBoundingClientRect();
    return Math.min(r.bottom, scroll.bottom) - Math.max(r.y, scroll.y);
  });
  expect(visibleHeight).toBeGreaterThanOrEqual(180);

  await page
    .getByLabel("生成模型", { exact: true })
    .selectOption("gpt-image-2.5-sunburst");
  await expect(page.getByLabel("生成尺寸", { exact: true })).toBeVisible();
  await expect(page.getByLabel("生成质量", { exact: true })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("sidebar-desktop.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "收起工具参数", exact: true }).click();
  await expect(prompt).toHaveValue(longPrompt);
  await expect(page.getByLabel("文字内容", { exact: true })).toBeVisible();
  await expect(page.getByLabel("生成模型", { exact: true })).toHaveValue(
    "gpt-image-2.5-sunburst",
  );
  const before = await prompt.boundingBox();
  if (!before) throw Error("missing prompt");
  await page.mouse.move(
    before.x + before.width - 3,
    before.y + before.height - 3,
  );
  await page.mouse.down();
  await page.mouse.move(
    before.x + before.width - 3,
    before.y + before.height + 65,
    { steps: 8 },
  );
  await page.mouse.up();
  const after = await prompt.boundingBox();
  expect(after!.height).toBeGreaterThan(before.height + 30);
  await expect(prompt).toHaveValue(longPrompt);
});

test("narrow screens can open and close the generation sidebar", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/canvas/");
  await expect(
    page.getByRole("complementary", { name: "工具与生成面板" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "生成与工具", exact: true }).click();
  await expect(page.getByLabel("生成描述", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "收起工具参数", exact: true }).click();
  await page
    .getByLabel("生成描述", { exact: true })
    .fill("窄屏提示词仍可编辑。");
  await page.screenshot({
    path: info.outputPath("sidebar-mobile.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "生成与工具", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "工具与生成面板" }),
  ).toBeHidden();
});
