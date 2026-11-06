import { test, expect } from "@playwright/test";
test("production: default legacy, lazy canvas, retained states, legacy generation and explicit image exchange", async ({
  page,
}, info) => {
  let canvasRequests = 0;
  page.on("request", (r) => {
    if (r.url().includes("/canvas/")) canvasRequests++;
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("tab", { name: "原有界面", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(canvasRequests).toBe(0);
  const segment = await page.locator('.topbar [role="tablist"]').boundingBox();
  const promptLink = await page.locator("#promptLink").boundingBox();
  expect(segment).toBeTruthy();
  expect(promptLink).toBeTruthy();
  expect(segment!.x + segment!.width).toBeLessThan(promptLink!.x);
  expect(
    Math.abs(
      segment!.y + segment!.height / 2 - promptLink!.y - promptLink!.height / 2,
    ),
  ).toBeLessThan(2);
  await page
    .locator(".topbar")
    .screenshot({ path: info.outputPath("segmented-topbar.png") });

  await page.locator("#prompt").fill("保留原界面表单");
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    const x = c.getContext("2d")!;
    x.fillStyle = "#386c98";
    x.fillRect(0, 0, 400, 300);
    return c.toDataURL().split(",")[1];
  });
  let body: any;
  await page.route("**/api/v1/generate", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ json: { task_id: "legacy-mock", images: [] } });
  });
  let completed = false;
  await page.route("**/api/v1/tasks/legacy-mock", (route) =>
    route.fulfill({
      json: {
        task_id: "legacy-mock",
        status: completed ? "completed" : "running",
        progress: completed ? 100 : 20,
        images: completed ? [{ base64: data, adjusted_size: "400x300" }] : [],
      },
    }),
  );
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(page.locator("#loaderTaskId")).toHaveText("legacy-mock");
  await page
    .getByRole("tab", { name: "画布工作区 · 预览", exact: true })
    .click();
  await expect(
    page
      .frameLocator("iframe")
      .getByRole("heading", { name: "从一张图片开始" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "原有界面", exact: true }).click();
  await expect(page.locator("#loaderTaskId")).toHaveText("legacy-mock");
  await expect(page.locator("#generateBtn")).toBeDisabled();
  completed = true;
  await expect(page.locator("#imagesGrid .img-card")).toHaveCount(1);
  expect(body.prompt).toBe("保留原界面表单");
  expect(body.mask_base64).toBeUndefined();
  await page.getByRole("button", { name: "插入画布", exact: true }).click();
  const canvas = page.frameLocator('iframe[title="画布工作区"]');
  await expect(
    canvas.getByLabel("当前图片", { exact: true }).locator("option:checked"),
  ).toHaveText("插入图片.png");
  expect(canvasRequests).toBeGreaterThan(0);
  await canvas.getByRole("button", { name: "文字", exact: true }).click();
  await canvas.getByLabel("文字内容", { exact: true }).fill("画布自己的表单");
  await page.getByRole("tab", { name: "原有界面", exact: true }).click();
  await expect(page.locator("#prompt")).toHaveValue("保留原界面表单");
  await expect(page.locator("#imagesGrid .img-card")).toHaveCount(1);
  await page
    .getByRole("tab", { name: "画布工作区 · 预览", exact: true })
    .click();
  await expect(canvas.getByLabel("文字内容", { exact: true })).toHaveValue(
    "画布自己的表单",
  );
  await expect(
    canvas.getByLabel("当前图片", { exact: true }).locator("option:checked"),
  ).toHaveText("插入图片.png");
  await canvas.getByRole("button", { name: "选择", exact: true }).click();
  await canvas.getByRole("button", { name: "作为原界面参考图" }).click();
  await expect(
    page.getByRole("tab", { name: "原有界面", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#imagePreview img")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("production-legacy.png") });
  await page
    .getByRole("tab", { name: "画布工作区 · 预览", exact: true })
    .click();
  await page.screenshot({ path: info.outputPath("production-canvas.png") });
  await page.reload();
  await expect(
    page.getByRole("tab", { name: "原有界面", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(errors).toEqual([]);
});
