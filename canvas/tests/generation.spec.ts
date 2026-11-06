import { test, expect } from "@playwright/test";
async function image(page: any, color = "#235680") {
  return page.evaluate((color) => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    const x = c.getContext("2d")!;
    x.fillStyle = color;
    x.fillRect(0, 0, 400, 300);
    return c.toDataURL().split(",")[1];
  }, color);
}
async function importImage(page: any, data: string, name = "original.png") {
  await page.locator("input[type=file]").setInputFiles({
    name,
    mimeType: "image/png",
    buffer: Buffer.from(data, "base64"),
  });
  await expect(page.getByRole("heading", { name })).toBeVisible();
}
test("masked snapshot, independent concurrent results and subsequent editing", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/canvas/");
  const data = await image(page);
  await importImage(page, data);
  await page.getByRole("button", { name: "文字", exact: true }).click();
  const box = await page.locator(".stage-host").boundingBox();
  if (!box) throw Error("canvas");
  await page.mouse.click(box.x + 100, box.y + 90);
  await page.getByRole("button", { name: "圈选区域", exact: true }).click();
  await page.mouse.move(box.x + 130, box.y + 130);
  await page.mouse.down();
  await page.mouse.move(box.x + 210, box.y + 130);
  await page.mouse.move(box.x + 210, box.y + 210);
  await page.mouse.move(box.x + 130, box.y + 210);
  await page.mouse.up();
  await page
    .getByRole("button", { name: "选中图片作为参考", exact: true })
    .click();
  await page.getByLabel("使用主参考图 PNG mask").check();
  await page.getByLabel("生成描述", { exact: true }).fill("第一任务");
  const submissions: any[] = [];
  await page.route("**/api/v1/generate", async (r) => {
    submissions.push(r.request().postDataJSON());
    await r.fulfill({
      json: { task_id: "job-" + submissions.length, images: [] },
    });
  });
  let completed = false;
  await page.route("**/api/v1/tasks/job-*", (r) => {
    const task = r.request().url().split("/").pop();
    return r.fulfill({
      json: {
        task_id: task,
        status: completed ? "completed" : "running",
        progress: completed ? 100 : 20,
        images: completed ? [{ base64: data, adjusted_size: "400x300" }] : [],
      },
    });
  });
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(page.locator(".job-list>div")).toHaveCount(1);
  await expect(page.locator(".job-list")).toContainText("生成中");
  const first = submissions[0];
  expect(first.mask_base64).toBeTruthy();
  expect(first.image_base64s).toHaveLength(1);
  expect(first.preserve_source_base64).toBe(data);
  expect(first.preserve_outside_mask).toBe(true);
  expect(first.image_base64s[0]).not.toBe(first.preserve_source_base64);
  // Edits after submission must survive asynchronous completion.
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await page.getByLabel("旋转角度").fill("30");
  await page.getByLabel("旋转角度").blur();
  await page.getByLabel("使用主参考图 PNG mask").uncheck();
  await page.getByRole("button", { name: "纯文本生成", exact: true }).click();
  await page.getByLabel("生成描述", { exact: true }).fill("第二任务");
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(page.locator(".job-list>div")).toHaveCount(2);
  expect(submissions[1].image_base64s).toBeUndefined();
  expect(submissions[1].mask_base64).toBeUndefined();
  expect(submissions[1].client_request_id).not.toBe(first.client_request_id);
  completed = true;
  await expect(page.locator(".job-list")).toContainText(
    "生成结果已作为新图片回填",
  );
  await expect(
    page
      .locator(".job-list>div")
      .filter({ hasText: "生成结果已作为新图片回填" }),
  ).toHaveCount(2);
  await expect(page.getByLabel("旋转角度")).toHaveValue("30");
  await expect(page.locator(".marks>div")).toHaveCount(1);
  await page.locator(".stage-host").focus();
  await page.keyboard.press("Control+a");
  await expect(
    page.getByText("已选中 3 张图片", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "适配内容" }).click();
  await page.screenshot({ path: info.outputPath("generation-loop.png") });
  // Select a new result via image click, then attach new annotation.
  const stage = await page.locator(".stage-host").boundingBox();
  if (!stage) throw Error("stage");
  await page
    .getByLabel("当前图片", { exact: true })
    .selectOption({ label: "生成结果 job-2 · 1" });
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.getByLabel("文字内容", { exact: true }).fill("再次编辑");
  await page.mouse.click(
    stage.x + stage.width - 150,
    stage.y + stage.height / 2,
  );
  await expect(page.locator(".marks")).toContainText("再次编辑");
  expect(errors).toEqual([]);
});
test("ordered references and interrupted submit reuse ID; failed task retries use a new ID", async ({
  page,
}) => {
  await page.goto("/canvas/");
  const data = await image(page);
  await importImage(page, data);
  const secondData = await image(page, "#ff0000");
  await importImage(page, secondData, "second.png");
  await page.locator(".stage-host").focus();
  await page.keyboard.press("Control+a");
  await page
    .getByRole("button", { name: "选中图片作为参考", exact: true })
    .click();
  await page.getByRole("button", { name: "前移参考图 2" }).click();
  await expect(page.locator(".generation-inputs li").first()).toContainText(
    "second.png",
  );
  await page.getByLabel("生成描述", { exact: true }).fill("重试测试");
  const submissions: any[] = [];
  await page.route("**/api/v1/generate", async (r) => {
    submissions.push(r.request().postDataJSON());
    if (submissions.length === 1) await r.abort("failed");
    else
      await r.fulfill({
        json: { task_id: "retry-" + submissions.length, images: [] },
      });
  });
  await page.route("**/api/v1/tasks/retry-*", (r) =>
    r.fulfill({
      json: {
        task_id: "retry",
        status: "failed",
        progress: 0,
        images: [],
        error: "受控失败",
      },
    }),
  );
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重试提交（同一请求）" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重试提交（同一请求）" }).click();
  await expect(
    page.getByRole("button", { name: "重新生成（新任务）" }),
  ).toBeVisible();
  expect(submissions[0].client_request_id).toBe(
    submissions[1].client_request_id,
  );
  expect(submissions[0].image_base64s).toHaveLength(2);
  expect(submissions[0].image_base64s[0]).toBe(secondData);
  await page.getByRole("button", { name: "重新生成（新任务）" }).click();
  await expect(page.locator(".job-list>div")).toHaveCount(2);
  expect(submissions[2].client_request_id).not.toBe(
    submissions[1].client_request_id,
  );
});

test("unsupported mask model and missing task are explicit, query retry never submits again", async ({
  page,
}) => {
  await page.goto("/canvas/");
  await page.getByLabel("生成描述", { exact: true }).fill("恢复查询");
  await page.getByLabel("使用主参考图 PNG mask").check();
  await page.getByLabel("生成模型", { exact: true }).selectOption("image-01");
  await expect(page.getByRole("alert")).toContainText("不支持 PNG mask");
  await expect(
    page.getByRole("button", { name: "生成图片", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("使用主参考图 PNG mask").uncheck();
  await page
    .getByLabel("生成模型", { exact: true })
    .selectOption("gpt-image-2.5-flare");
  let submissions = 0;
  await page.route("**/api/v1/generate", (r) => {
    submissions++;
    return r.fulfill({ json: { task_id: "missing" } });
  });
  let queries = 0;
  await page.route("**/api/v1/tasks/missing", (r) => {
    queries++;
    return r.fulfill({ status: 404, json: { detail: "Task not found" } });
  });
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(page.locator(".job-list")).toContainText("服务可能已重启");
  expect(submissions).toBe(1);
  expect(queries).toBe(1);
  await page.getByRole("button", { name: "继续查询" }).click();
  await expect.poll(() => queries).toBe(2);
  expect(submissions).toBe(1);
});
