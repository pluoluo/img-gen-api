import { test, expect, chromium, Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function start(page: Page) {
  await page.goto("/canvas/");
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
}
async function importImage(page: Page, name = "保存测试.png") {
  const data = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 400;
    c.height = 300;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#235680";
    ctx.fillRect(0, 0, 400, 300);
    return c.toDataURL().split(",")[1];
  });
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name,
      mimeType: "image/png",
      buffer: Buffer.from(data, "base64"),
    });
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  return data;
}
async function history(page: Page) {
  if (
    !(await page
      .getByRole("region", { name: "历史画布", exact: true })
      .isVisible())
  )
    await page.getByRole("button", { name: "历史画布", exact: true }).click();
}
async function save(page: Page, title?: string) {
  await history(page);
  if (title) await page.getByLabel("画布名称", { exact: true }).fill(title);
  await page.getByRole("button", { name: "保存当前版本", exact: true }).click();
  await expect(page.locator(".project-save-state")).toContainText("已保存");
  const name = await page.getByLabel("画布名称", { exact: true }).inputValue();
  const projects = await (
    await page.request.get("/api/v1/canvas/projects?limit=200")
  ).json();
  const project = projects.items.find((p: any) => p.title === name);
  expect(project).toBeTruthy();
  const loaded = await (
    await page.request.get("/api/v1/canvas/projects/" + project.id)
  ).json();
  await page.getByRole("button", { name: "关闭历史", exact: true }).click();
  return loaded;
}

test("save exact editing state, reload with undo/redo and branch from an old version", async ({
  page,
}, info) => {
  await start(page);
  await importImage(page);
  const box = await page.locator(".stage-host").boundingBox();
  if (!box) throw Error("canvas");
  const point = (x: number, y: number) => ({
    x: box.x + 50 + x * 0.8,
    y: box.y + 50 + y * 0.8,
  });
  await page.getByRole("button", { name: "文字", exact: true }).click();
  await page.getByLabel("文字内容", { exact: true }).fill("保留中文历史标注");
  await page.mouse.click(point(50, 40).x, point(50, 40).y);
  await page.getByRole("button", { name: "圈选区域", exact: true }).click();
  await page.mouse.move(point(100, 100).x, point(100, 100).y);
  await page.mouse.down();
  for (const [x, y] of [
    [200, 100],
    [200, 200],
    [100, 200],
    [100, 100],
  ])
    await page.mouse.move(point(x, y).x, point(x, y).y);
  await page.mouse.up();
  await page.getByRole("button", { name: "裁剪", exact: true }).click();
  await page.mouse.move(point(40, 30).x, point(40, 30).y);
  await page.mouse.down();
  await page.mouse.move(point(340, 260).x, point(340, 260).y, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: "选择", exact: true }).click();
  await page.getByLabel("旋转角度", { exact: true }).fill("37");
  await page.getByLabel("旋转角度", { exact: true }).blur();
  await page
    .getByRole("button", { name: "选中图片作为参考", exact: true })
    .click();
  await page.getByLabel("使用主参考图 PNG mask").check();
  await page
    .getByLabel("生成描述", { exact: true })
    .fill("刷新后保留的长提示词。\n".repeat(80));
  await page.getByLabel("生成质量", { exact: true }).selectOption("high");
  await page.mouse.move(box.x + 500, box.y + 350);
  await page.mouse.wheel(0, -100);
  await page.locator(".stage-host").focus();
  await page.keyboard.down("Space");
  await page.mouse.move(box.x + 600, box.y + 450);
  await page.mouse.down();
  await page.mouse.move(box.x + 650, box.y + 480, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  const first = await save(page, "历史精确恢复测试");
  expect(first.snapshot.document.images[0].marks).toHaveLength(1);
  expect(first.snapshot.document.images[0].regions).toHaveLength(1);
  expect(first.snapshot.document.images[0].crop).toMatchObject({
    width: 300,
    height: 230,
  });
  expect(first.snapshot.history.past.length).toBeGreaterThanOrEqual(5);
  for (const asset of Object.values(first.snapshot.assets) as any[])
    expect(asset.url).toMatch(/^\/api\/v1\/canvas\/assets\/[a-f0-9]{64}$/);
  expect(JSON.stringify(first.snapshot)).not.toContain("base64,");
  await page.reload();
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
  await expect(page.getByLabel("旋转角度", { exact: true })).toHaveValue("37");
  await expect(page.getByLabel("生成描述", { exact: true })).toHaveValue(
    first.snapshot.generator.prompt,
  );
  await expect(page.getByLabel("生成质量", { exact: true })).toHaveValue(
    "high",
  );
  await expect(page.getByLabel("使用主参考图 PNG mask")).toBeChecked();
  await expect(page.locator(".marks")).toContainText("保留中文历史标注");
  const same = await save(page);
  expect(same.snapshot.document).toEqual(first.snapshot.document);
  expect(same.snapshot.history).toEqual(first.snapshot.history);
  expect(same.snapshot.view).toEqual(first.snapshot.view);
  await page.getByRole("button", { name: "撤销", exact: true }).click();
  await expect(page.getByLabel("旋转角度", { exact: true })).toHaveValue("0");
  await page.getByRole("button", { name: "重做", exact: true }).click();
  await expect(page.getByLabel("旋转角度", { exact: true })).toHaveValue("37");
  await page.getByLabel("旋转角度", { exact: true }).fill("80");
  await page.getByLabel("旋转角度", { exact: true }).blur();
  await page.getByLabel("生成描述", { exact: true }).fill("后续版本");
  const later = await save(page);
  expect(later.head_revision).toBeGreaterThan(first.head_revision);
  await history(page);
  await page
    .getByRole("button", {
      name: new RegExp(
        "^打开版本 " + first.head_revision + "(?: · 当前保存点)? ",
      ),
    })
    .click();
  await expect(page.getByLabel("旋转角度", { exact: true })).toHaveValue("37");
  await expect(page.getByLabel("生成描述", { exact: true })).toHaveValue(
    first.snapshot.generator.prompt,
  );
  await page.getByLabel("旋转角度", { exact: true }).fill("55");
  await page.getByLabel("旋转角度", { exact: true }).blur();
  const branched = await save(page);
  expect(branched.head_revision).toBeGreaterThan(later.head_revision);
  const preserved = await (
    await page.request.get(
      "/api/v1/canvas/projects/" +
        first.id +
        "?revision=" +
        later.head_revision,
    )
  ).json();
  expect(preserved.snapshot.document.images[0].rotation).toBe(80);
  await history(page);
  await page.screenshot({
    path: info.outputPath("saved-history.png"),
    animations: "disabled",
  });
});

test("closing and restarting the browser restores images and can open another saved canvas", async ({
  baseURL,
}) => {
  const folder = mkdtempSync(join(tmpdir(), "canvas-profile-"));
  let context = await chromium.launchPersistentContext(folder, {
    headless: true,
    baseURL,
    viewport: { width: 1440, height: 960 },
  });
  try {
    let page = context.pages()[0];
    await start(page);
    await importImage(page, "跨浏览器图片.png");
    await page
      .getByLabel("生成描述", { exact: true })
      .fill("浏览器关闭前的描述");
    const first = await save(page, "浏览器重启测试");
    await context.close();
    context = await chromium.launchPersistentContext(folder, {
      headless: true,
      baseURL,
      viewport: { width: 1440, height: 960 },
    });
    page = context.pages()[0];
    await start(page);
    await expect(
      page.getByRole("heading", { name: "跨浏览器图片.png" }),
    ).toBeVisible();
    await expect(page.getByLabel("生成描述", { exact: true })).toHaveValue(
      "浏览器关闭前的描述",
    );
    await history(page);
    await page.getByRole("button", { name: "新建画布", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "从一张图片开始" }),
    ).toBeVisible();
    await importImage(page, "另一个项目.png");
    const second = await save(page, "另一个画布测试");
    expect(second.id).not.toBe(first.id);
    await history(page);
    await page.getByRole("tab", { name: "已保存画布", exact: true }).click();
    await page
      .locator(".history-items button")
      .filter({ hasText: "浏览器重启测试" })
      .click();
    await expect(
      page.getByRole("heading", { name: "跨浏览器图片.png" }),
    ).toBeVisible();
    await expect(page.getByLabel("生成描述", { exact: true })).toHaveValue(
      "浏览器关闭前的描述",
    );
    const reopened = await save(page);
    expect(reopened.id).toBe(first.id);
  } finally {
    await context.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test("server failure keeps a complete local backup and retry saves the same canvas", async ({
  page,
}) => {
  await page.route("**/api/v1/canvas/**", (r) => r.abort());
  await start(page);
  await importImage(page, "离线备份.png");
  await page
    .getByLabel("生成描述", { exact: true })
    .fill("服务器不可用时的工作");
  await expect(page.locator(".save-state")).toContainText("服务器保存失败");
  await page.reload();
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "离线备份.png" }),
  ).toBeVisible();
  await expect(page.getByLabel("生成描述", { exact: true })).toHaveValue(
    "服务器不可用时的工作",
  );
  await expect(page.locator(".save-state")).toContainText("服务器保存失败");
  await page.unroute("**/api/v1/canvas/**");
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.locator(".save-state")).toContainText("已保存");
  const loaded = await save(page, "离线后恢复测试");
  expect(loaded.snapshot.document.images).toHaveLength(1);
  expect(loaded.snapshot.generator.prompt).toBe("服务器不可用时的工作");
});

test("two windows detect conflicts and saving a copy preserves both edits", async ({
  page,
  context,
}) => {
  await start(page);
  await importImage(page);
  const original = await save(page, "多窗口保护测试");
  const other = await context.newPage();
  await start(other);
  await expect(
    other.getByRole("heading", { name: "保存测试.png" }),
  ).toBeVisible();
  await expect(other.locator(".save-state")).toContainText("版本");
  await page.getByLabel("旋转角度", { exact: true }).fill("11");
  await page.getByLabel("旋转角度", { exact: true }).blur();
  await save(page);
  await other.getByLabel("旋转角度", { exact: true }).fill("22");
  await other.getByLabel("旋转角度", { exact: true }).blur();
  await expect(other.locator(".save-error")).toContainText("其他窗口更新");
  await other
    .getByRole("button", { name: "另存为新画布", exact: true })
    .click();
  await expect(other.locator(".save-state")).toContainText("已保存");
  const copy = await save(other, "冲突副本测试");
  expect(copy.id).not.toBe(original.id);
  const preserved = await (
    await page.request.get("/api/v1/canvas/projects/" + original.id)
  ).json();
  expect(preserved.snapshot.document.images[0].rotation).toBe(11);
  expect(copy.snapshot.document.images[0].rotation).toBe(22);
});

test("refresh resumes an existing generation task without submitting it again", async ({
  page,
}) => {
  await start(page);
  const data = await importImage(page);
  let submitted = 0,
    completed = false;
  await page.route("**/api/v1/generate", (r) => {
    submitted++;
    return r.fulfill({ json: { task_id: "persisted-task" } });
  });
  await page.route("**/api/v1/tasks/persisted-task", (r) =>
    r.fulfill({
      json: {
        task_id: "persisted-task",
        status: completed ? "completed" : "running",
        progress: 20,
        images: completed ? [{ base64: data }] : [],
      },
    }),
  );
  await page.getByLabel("生成描述", { exact: true }).fill("恢复正在生成的结果");
  await page
    .getByRole("button", { name: "选中图片作为参考", exact: true })
    .click();
  await page.getByRole("button", { name: "生成图片", exact: true }).click();
  await expect(page.locator(".job-list")).toContainText("生成中");
  const saved = await save(page, "任务刷新恢复测试");
  expect(saved.snapshot.generator.jobs[0].taskId).toBe("persisted-task");
  completed = true;
  await page.reload();
  await expect(page.locator(".workspace-loading")).toHaveCount(0);
  await expect(page.locator(".job-list")).toContainText(
    "生成结果已作为新图片回填",
  );
  expect(submitted).toBe(1);
  const restored = await save(page);
  expect(restored.snapshot.document.images).toHaveLength(2);
  expect(restored.snapshot.document.images[1].source.taskId).toBe(
    "persisted-task",
  );
});
