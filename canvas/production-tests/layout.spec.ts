import { test, expect } from "@playwright/test";

async function expectViewportLayout(page: any) {
  const geometry = await page.evaluate(() => {
    const bounds = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        bottom: r.bottom,
        right: r.right,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      body: bounds("body"),
      header: bounds(".topbar"),
      legacy: bounds("#legacyWorkspace"),
      shell: bounds(".shell"),
      hint: bounds("#hintBar"),
      generate: bounds("#generateBtn"),
      lookup: bounds(".lookup-box"),
    };
  });
  expect(geometry.lookup.y).toBeGreaterThanOrEqual(geometry.generate.bottom);
  expect(geometry.body.height).toBe(geometry.viewport.height);
  expect(geometry.legacy.y).toBeCloseTo(geometry.header.bottom, 0);
  expect(geometry.hint.bottom).toBeCloseTo(geometry.viewport.height, 0);
  expect(geometry.shell.bottom).toBeCloseTo(geometry.hint.y, 0);
  expect(geometry.legacy.bottom).toBeCloseTo(geometry.viewport.height, 0);
  return geometry;
}

for (const viewport of [
  { width: 1440, height: 960 },
  { width: 1280, height: 720 },
  { width: 900, height: 960 },
  { width: 800, height: 600 },
  { width: 390, height: 844 },
]) {
  test(`viewport layout ${viewport.width}x${viewport.height}, including roundtrip and resize`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expectViewportLayout(page);
    if (viewport.width >= 1000) {
      expect((await page.locator(".topbar").boundingBox())!.height).toBe(48);
    }
    const tabs = page.getByRole("tab");
    await tabs.nth(1).click();
    await expect(
      page
        .frameLocator("iframe")
        .getByRole("button", { name: "导入图片", exact: true }),
    ).toBeVisible();
    const canvas = await page.locator("#canvasWorkspace").boundingBox();
    expect(canvas!.height).toBeGreaterThan(viewport.height / 2);
    expect(canvas!.y + canvas!.height).toBeCloseTo(viewport.height, 0);
    await tabs.nth(0).click();
    await expectViewportLayout(page);
    await page.screenshot({ path: info.outputPath("legacy-layout.png") });
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height + 140,
    });
    await expectViewportLayout(page);
  });
}

test("critical default layout and segmented control do not depend on a separate stylesheet", async ({
  page,
}) => {
  await page.route("**/workspace-assets/*.css", (route) => route.abort());
  await page.goto("/");
  await expectViewportLayout(page);
  const styles = await page
    .getByRole("tab", { name: "原有界面", exact: true })
    .evaluate((element: HTMLElement) => {
      const button = getComputedStyle(element);
      const group = getComputedStyle(element.parentElement!);
      return {
        buttonBackground: button.backgroundColor,
        borderRadius: group.borderRadius,
        groupDisplay: group.display,
      };
    });
  expect(styles.groupDisplay).toBe("flex");
  expect(styles.borderRadius).toBe("6px");
  expect(styles.buttonBackground).toBe("rgb(102, 126, 234)");
});
