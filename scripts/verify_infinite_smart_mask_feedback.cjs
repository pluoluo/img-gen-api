// Controlled worker responses exercise slow inference, queued prompts and stale replies.
const { chromium } = require('../canvas/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8781';
(async () => {
  assert.equal((await (await fetch(origin + '/api/v1/infinite/config')).json()).offline_validation, true);
  const browser = await chromium.launch({ headless: true });
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-mask-feedback-'));
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith('http') && new URL(url).origin !== origin) return route.abort();
      assert(!/\/generate(?:\?|$)|\/images\/(edits|generations)/.test(url));
      return route.continue();
    });
    await page.addInitScript(() => {
      const Original = window.Worker;
      window.maskWorkers = [];
      window.Worker = class extends Original {
        constructor(url, options) {
          if (!String(url).includes('smart-mask.worker')) return new Original(url, options);
          // Do not start model inference: the test controls each completion.
          const instance = { messages: [], postMessage(data) { this.messages.push(data); }, terminate() { this.stopped = true; } };
          window.maskWorkers.push(instance);
          return instance;
        }
      };
    });
    await page.goto(origin + '/infinite/canvas');
    await page.getByRole('button', { name: '新建画布', exact: true }).first().click();
    await page.waitForURL('**/infinite/canvas/*');
    const source = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 768; c.height = 512;
      const ctx = c.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 768, 512); return c.toDataURL().split(',')[1];
    });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '上传资产', exact: true }).click();
    await (await chooser).setFiles({ name: 'feedback.png', mimeType: 'image/png', buffer: Buffer.from(source, 'base64') });
    await page.locator('[data-node-id]').first().hover();
    await page.getByRole('button', { name: '添加蒙版遮罩后局部修改', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const canvas = dialog.getByLabel('蒙版编辑画布');
    const click = async (x, y, button = 'left') => {
      const box = await canvas.boundingBox(); await page.mouse.click(box.x + box.width * x, box.y + box.height * y, { button });
    };
    const last = () => page.evaluate(() => window.maskWorkers.at(-1).messages.at(-1));
    const emit = data => page.evaluate(data => {
      const worker = window.maskWorkers.at(-1); const id = worker.messages.at(-1).id;
      if (data.type === 'result') data.mask = { width: 768, height: 512, data: Uint8Array.from({ length: 768 * 512 }, (_, index) => Number(index % 768 < 384)) };
      worker.onmessage({ data: { id, ...data } });
    }, data);
    await click(100 / 768, 200 / 512);
    await dialog.getByRole('button', { name: '智能选区', exact: true }).click();
    assert.equal((await last()).type, 'prepare');
    await emit({ type: 'status', stage: 'loading', backend: 'webgpu', dtype: 'fp16', progress: 47 });
    await click(0.6, 0.5);
    await dialog.getByText('已记录 1 个点，计算完成后会处理最新点位。', { exact: true }).waitFor();
    assert.equal((await last()).type, 'prepare', 'Prompts during preparation must wait');
    await dialog.getByLabel('模型下载进度').waitFor();
    await emit({ type: 'status', stage: 'encoding' });
    await dialog.getByText('已用 1 秒', { exact: true }).first().waitFor();
    assert.equal(await dialog.locator('[data-smart-mask-stage]').getAttribute('data-smart-mask-backend'), 'webgpu');
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await emit({ type: 'ready', backend: 'webgpu', dtype: 'fp16' });
    await page.waitForFunction(() => window.maskWorkers.at(-1).messages.at(-1).type === 'predict');
    assert.equal((await last()).points.length, 1);
    await click(0.95, 0.95, 'right');
    await dialog.getByText('已记录 2 个点，计算完成后会处理最新点位。', { exact: true }).waitFor();
    const candidates = [{ index: 1, score: 0.9, misses: 0 }, { index: 2, score: 0.8, misses: 1 }, { index: 0, score: 0.7, misses: 2 }];
    await emit({ type: 'result', candidates, selected: 1 });
    await page.waitForFunction(() => window.maskWorkers.at(-1).messages.at(-1).points?.length === 2);
    assert.equal(await dialog.getByRole('button', { name: '加入蒙版', exact: true }).isDisabled(), true, 'Stale preview must not be applicable');
    await emit({ type: 'result', candidates, selected: 1 });
    await dialog.locator('[data-smart-mask-stage="ready"]').waitFor();
    assert.equal(await dialog.getByRole('button', { name: '加入蒙版', exact: true }).isEnabled(), true);
    const preview = () => dialog.evaluate(el => {
      const ctx = el.querySelectorAll('canvas')[2].getContext('2d');
      return [ctx.getImageData(50, 50, 1, 1).data[3], ctx.getImageData(700, 50, 1, 1).data[3]];
    });
    const messageCount = await page.evaluate(() => window.maskWorkers.at(-1).messages.length);
    assert.deepEqual(await preview(), [255, 0]);
    await dialog.getByRole('button', { name: '反选', exact: true }).click();
    assert.deepEqual(await preview(), [0, 255], 'Invert selects the complement in original image dimensions');
    if (process.env.INFINITE_TEST_SCREENSHOTS !== '0') await page.screenshot({ path: path.join(output, 'desktop-invert.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    if (process.env.INFINITE_TEST_SCREENSHOTS !== '0') await page.screenshot({ path: path.join(output, 'mobile-invert.png'), fullPage: true });
    assert(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog.getByRole('button', { name: '反选', exact: true }).click();
    assert.deepEqual(await preview(), [255, 0], 'Inverting twice restores the original preview');
    assert.equal(await page.evaluate(() => window.maskWorkers.at(-1).messages.length), messageCount, 'Invert never runs inference again');
    await dialog.getByRole('button', { name: '方案 2', exact: true }).click();
    assert.deepEqual({ type: (await last()).type, index: (await last()).index }, { type: 'candidate', index: 2 });
    await emit({ type: 'result', candidates, selected: 2 });
    await dialog.getByText('部分点位与选区边缘有偏差，可切换方案、撤销上一个点或继续补点。', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '撤销点', exact: true }).click();
    assert.equal((await last()).points.length, 1);
    await dialog.getByRole('button', { name: '重新选取', exact: true }).click();
    await emit({ type: 'result', candidates, selected: 1 });
    await dialog.locator('[data-smart-mask-stage="ready"]').waitFor();
    assert.equal(await dialog.getByRole('button', { name: '加入蒙版', exact: true }).isDisabled(), true, 'Clear invalidates in-flight results');
    assert.equal(await dialog.getByRole('button', { name: '反选', exact: true }).isDisabled(), true);
    const committed = () => dialog.evaluate(el => {
      const ctx = el.querySelector('canvas.hidden').getContext('2d');
      return { left: ctx.getImageData(50, 50, 1, 1).data[3], right: ctx.getImageData(700, 50, 1, 1).data[3], brush: ctx.getImageData(100, 200, 1, 1).data[3] };
    });
    await click(0.5, 0.5);
    assert.equal(await dialog.getByRole('button', { name: '反选', exact: true }).isDisabled(), true);
    await emit({ type: 'result', candidates, selected: 1 });
    await dialog.getByRole('button', { name: '反选', exact: true }).click();
    assert.deepEqual(await committed(), { left: 0, right: 0, brush: 255 }, 'Preview inversion preserves existing brush strokes');
    await dialog.getByRole('button', { name: '加入蒙版', exact: true }).click();
    assert.deepEqual(await committed(), { left: 0, right: 255, brush: 255 });
    await dialog.getByRole('button', { name: '撤回局部涂抹', exact: true }).click();
    assert.deepEqual(await committed(), { left: 0, right: 0, brush: 255 });
    await dialog.getByRole('button', { name: '重做局部涂抹', exact: true }).click();
    assert.deepEqual(await committed(), { left: 0, right: 255, brush: 255 });
    await click(0.5, 0.5);
    await emit({ type: 'result', candidates, selected: 1 });
    await dialog.getByRole('button', { name: '反选', exact: true }).click();
    await dialog.getByRole('button', { name: '从蒙版减去', exact: true }).click();
    assert.deepEqual(await committed(), { left: 0, right: 0, brush: 255 });
    await click(0.5, 0.5);
    await dialog.getByRole('button', { name: '切换 CPU', exact: true }).click();
    assert.equal((await last()).cpu, true);
    await dialog.getByText('已记录 1 个点，计算完成后会处理最新点位。', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '停止', exact: true }).click();
    await emit({ type: 'ready', backend: 'wasm', dtype: 'q8' });
    await dialog.locator('[data-smart-mask-stage="idle"]').waitFor();
    assert(await page.evaluate(() => window.maskWorkers.every(w => w.stopped)));
    assert.equal(await dialog.evaluate(el => el.querySelector('canvas.hidden').getContext('2d').getImageData(100, 200, 1, 1).data[3]), 255);
    assert.deepEqual(failures, []);
    console.log(JSON.stringify({ invertPreview: true, invertTwice: true, invertWithoutInference: true, invertedAddSubtractUndoRedo: true, queuedPreparation: true, coalescedPrompts: true, stalePreviewRejected: true, candidates: true, undoPoint: true, clearDuringInference: true, manualCpuSwitch: true, stopIgnoresLateReplies: true, elapsedAndProgress: true, output }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
