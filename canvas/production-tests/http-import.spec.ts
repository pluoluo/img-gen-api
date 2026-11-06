import { test, expect } from "@playwright/test";

test("image upload, drop, duplicate and annotation work over ordinary HTTP", async ({
  page,
}, info) => {
  // A non-localhost HTTP origin reproduces LAN browser security restrictions.
  const origin = "http://canvas-preview.test";
  const server = String(info.project.use.baseURL).replace(/\/$/, "");
  await page.route(origin + "/**", async (route) => {
    const response = await route.fetch({
      url: route.request().url().replace(origin, server),
    });
    await route.fulfill({ response });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/canvas/");
  const environment = await page.evaluate(() => ({
    secure: isSecureContext,
    uuid: typeof crypto.randomUUID,
    random: typeof crypto.getRandomValues,
  }));
  expect(environment).toEqual({
    secure: false,
    uuid: "undefined",
    random: "function",
  });
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#235680";
    ctx.fillRect(0, 0, 400, 300);
    return c.toDataURL().split(",")[1];
  });
  await page.locator("input[type=file]").setInputFiles({
    name: "http-upload.png",
    mimeType: "image/png",
    buffer: Buffer.from(data, "base64"),
  });
  await expect(
    page.getByRole("heading", { name: "http-upload.png" }),
  ).toBeVisible();
  await page.locator(".stage-host").evaluate(async (el, b64) => {
    const blob = await (await fetch("data:image/png;base64," + b64)).blob(),
      transfer = new DataTransfer();
    transfer.items.add(
      new File([blob], "http-drop.png", { type: "image/png" }),
    );
    el.dispatchEvent(
      new DragEvent("drop", { bubbles: true, dataTransfer: transfer }),
    );
  }, data);
  await expect(
    page.getByRole("heading", { name: "http-drop.png" }),
  ).toBeVisible();
  await page.locator(".stage-host").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+d");
  await page.keyboard.press("Control+a");
  await expect(
    page.getByText("已选中 4 张图片", { exact: true }),
  ).toBeVisible();
  const identifiers = await page
    .getByLabel("当前图片", { exact: true })
    .locator("option")
    .evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter(Boolean),
    );
  expect(new Set(identifiers).size).toBe(4);
  for (const value of identifiers)
    expect(value).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  await page
    .getByLabel("当前图片", { exact: true })
    .selectOption(identifiers[0]);
  await page.getByRole("button", { name: "文字", exact: true }).click();
  const box = await page.locator(".stage-host").boundingBox();
  if (!box) throw Error("missing canvas");
  await page.mouse.click(box.x + 150, box.y + 120);
  await expect(page.locator(".marks")).toContainText("中文标注");
  expect(errors).toEqual([]);
});
