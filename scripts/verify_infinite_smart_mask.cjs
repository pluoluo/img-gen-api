// Real SAM 2.1 Tiny inference on an isolated offline service; never submits generation.
const { chromium } = require('../canvas/node_modules/playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8781';
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'infinite-smart-mask-'));

async function ready(dialog) {
  await dialog.locator('[data-smart-mask-stage="ready"], [data-smart-mask-stage="error"]').waitFor({ timeout: 120000 });
  const error = await dialog.locator('[data-smart-mask-stage="error"]').count();
  assert.equal(error, 0, await dialog.innerText());
}
async function clickPoint(page, dialog, x, y, button = 'left') {
  const box = await dialog.getByLabel('蒙版编辑画布').boundingBox();
  await page.mouse.click(box.x + box.width * x, box.y + box.height * y, { button });
  await ready(dialog);
  await dialog.getByRole('button', { name: '加入蒙版', exact: true }).waitFor();
  await page.waitForFunction(() => !Array.from(document.querySelectorAll('[role=dialog] button')).find(button => button.textContent === '加入蒙版').disabled);
}
async function painted(dialog) {
  return dialog.evaluate(element => {
    const canvas = element.querySelector('canvas.hidden');
    const ctx = canvas.getContext('2d');
    return { center: ctx.getImageData(440, 256, 1, 1).data[3], brush: ctx.getImageData(100, 200, 1, 1).data[3], outside: ctx.getImageData(750, 500, 1, 1).data[3] };
  });
}

(async () => {
  const config = await (await fetch(origin + '/api/v1/infinite/config')).json();
  assert.equal(config.offline_validation, true, 'Requires INFINITE_OFFLINE_VALIDATION=1');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: process.env.INFINITE_TEST_HTTPS === '1' });
    const failures = [], outsideRequests = [], generationRequests = [], modelRequests = [];
    page.on('pageerror', error => failures.push(error.message));
    const guardRequests = async route => {
      const url = route.request().url();
      // The pre-existing update checker is unrelated to segmentation.
      if (url === 'https://raw.githubusercontent.com/basketikun/infinite-canvas/main/VERSION') return route.fulfill({ body: fs.readFileSync(path.resolve(__dirname, '../infinite/VERSION'), 'utf8') });
      if (/\/generate(?:\?|$)|\/images\/(edits|generations)/.test(url)) { generationRequests.push(url); return route.abort(); }
      if (url.startsWith('http') && new URL(url).origin !== origin) { outsideRequests.push(url); return route.abort(); }
      if (url.includes('/smart-mask/')) modelRequests.push(url);
      return route.continue();
    };
    await page.route('**/*', guardRequests);
    await page.goto(origin + '/infinite/canvas');
    await page.getByRole('button', { name: '新建画布', exact: true }).first().click();
    await page.waitForURL('**/infinite/canvas/*');
    const source = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 768; canvas.height = 512;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 768, 512);
      ctx.fillStyle = 'green'; ctx.beginPath(); ctx.arc(440, 256, 130, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'red'; ctx.fillRect(50, 150, 130, 220);
      return canvas.toDataURL().split(',')[1];
    });
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '上传资产', exact: true }).click();
    await (await chooser).setFiles({ name: 'smart-mask.png', mimeType: 'image/png', buffer: Buffer.from(source, 'base64') });
    await page.locator('[data-node-id]').first().hover();
    await page.getByRole('button', { name: '添加蒙版遮罩后局部修改', exact: true }).click();
    const dialog = page.getByRole('dialog');
    assert.equal(modelRequests.length, 0, 'Model must load only on demand');
    const box = await dialog.getByLabel('蒙版编辑画布').boundingBox();
    await page.mouse.click(box.x + box.width * 100 / 768, box.y + box.height * 200 / 512);
    assert.equal((await painted(dialog)).brush, 255);
    await page.evaluate(() => {
      window.smartStages = []; window.smartProgress = [];
      new MutationObserver(() => {
        const stage = document.querySelector('[data-smart-mask-stage]')?.dataset.smartMaskStage;
        if (stage && window.smartStages.at(-1) !== stage) window.smartStages.push(stage);
        for (const el of document.querySelectorAll('[aria-label="模型下载进度"]')) {
          const percent = el.getAttribute('aria-valuenow');
          if (percent !== null) window.smartProgress.push(Number(percent));
        }
      }).observe(document.body, { subtree: true, attributes: true, childList: true });
    });
    const start = Date.now();
    await dialog.getByRole('button', { name: '智能选区', exact: true }).click();
    await ready(dialog);
    const prepareMs = Date.now() - start;
    const backend = await dialog.locator('[data-smart-mask-stage]').getAttribute('data-smart-mask-backend');
    if (!await page.evaluate(() => isSecureContext)) assert.equal(backend, 'wasm');
    const decodeStart = Date.now();
    await clickPoint(page, dialog, 440 / 768, 0.5);
    const decodeMs = Date.now() - decodeStart;
    assert.equal((await painted(dialog)).center, 0, 'Preview must not change the committed mask');
    await clickPoint(page, dialog, 0.95, 0.95, 'right');
    const modelRequestsBeforeCandidates = modelRequests.length;
    await dialog.getByRole('button', { name: '方案 2', exact: true }).click();
    await ready(dialog);
    await dialog.getByRole('button', { name: '方案 1', exact: true }).click();
    await ready(dialog);
    assert.equal(modelRequests.length, modelRequestsBeforeCandidates, 'Candidates reuse decoder outputs');
    await dialog.getByRole('button', { name: '撤销点', exact: true }).click();
    await ready(dialog);
    if (process.env.INFINITE_TEST_SCREENSHOTS !== '0') await page.screenshot({ path: path.join(output, 'desktop.png') });
    await dialog.getByRole('button', { name: '加入蒙版', exact: true }).click();
    assert.deepEqual(await painted(dialog), { center: 255, brush: 255, outside: 0 });
    await dialog.getByRole('button', { name: '撤回局部涂抹', exact: true }).click();
    assert.deepEqual(await painted(dialog), { center: 0, brush: 255, outside: 0 });
    await dialog.getByRole('button', { name: '重做局部涂抹', exact: true }).click();
    assert.deepEqual(await painted(dialog), { center: 255, brush: 255, outside: 0 });
    await clickPoint(page, dialog, 440 / 768, 0.5);
    await dialog.getByRole('button', { name: '从蒙版减去', exact: true }).click();
    assert.deepEqual(await painted(dialog), { center: 0, brush: 255, outside: 0 });
    await dialog.getByRole('button', { name: '撤回局部涂抹', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    if (process.env.INFINITE_TEST_SCREENSHOTS !== '0') await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
    const dimensions = await dialog.evaluate(element => ({ scroll: element.scrollWidth, width: element.clientWidth }));
    assert(dimensions.scroll <= dimensions.width + 1, JSON.stringify(dimensions));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog.getByRole('button', { name: '导出到画布', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelectorAll('[data-node-id]').length === 2);
    // A failed model download must preserve hand painting and allow stopping/retrying.
    // A separate browser context also isolates the HTTPS model cache.
    const retryPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: process.env.INFINITE_TEST_HTTPS === '1' });
    retryPage.on('pageerror', error => failures.push(error.message));
    await retryPage.route('**/*', guardRequests);
    await retryPage.addInitScript(() => localStorage.setItem('infinite-canvas:theme_store', JSON.stringify({ state: { theme: 'light' } })));
    await retryPage.goto(origin + '/infinite/canvas');
    await retryPage.getByRole('button', { name: '新建画布', exact: true }).first().click();
    await retryPage.waitForURL('**/infinite/canvas/*');
    const retryChooser = retryPage.waitForEvent('filechooser');
    await retryPage.getByRole('button', { name: '上传资产', exact: true }).click();
    await (await retryChooser).setFiles({ name: 'smart-mask.png', mimeType: 'image/png', buffer: Buffer.from(source, 'base64') });
    await retryPage.locator('[data-node-id]').first().hover();
    await retryPage.getByRole('button', { name: '添加蒙版遮罩后局部修改', exact: true }).click();
    const retryDialog = retryPage.getByRole('dialog');
    const retryBox = await retryDialog.getByLabel('蒙版编辑画布').boundingBox();
    await retryPage.mouse.click(retryBox.x + retryBox.width * 100 / 768, retryBox.y + retryBox.height * 200 / 512);
    await retryPage.route('**/smart-mask/models/**', route => route.abort());
    await retryDialog.getByRole('button', { name: '智能选区', exact: true }).click();
    await retryDialog.locator('[data-smart-mask-stage="error"]').waitFor();
    assert.equal((await painted(retryDialog)).brush, 255);
    if (process.env.INFINITE_TEST_SCREENSHOTS !== '0') await retryPage.screenshot({ path: path.join(output, 'light-error.png') });
    await retryPage.unroute('**/smart-mask/models/**');
    await retryDialog.getByRole('button', { name: '使用 CPU 重新加载', exact: true }).click();
    await retryDialog.getByRole('button', { name: '停止', exact: true }).click();
    await retryDialog.locator('[data-smart-mask-stage="idle"]').waitFor();
    assert.equal((await painted(retryDialog)).brush, 255);
    await retryDialog.getByRole('button', { name: '画笔', exact: true }).click();
    await retryPage.keyboard.press('Escape');
    await retryDialog.waitFor({ state: 'detached' });
    assert.deepEqual(failures, []); assert.deepEqual(outsideRequests, []); assert.deepEqual(generationRequests, []);
    const phases = await page.evaluate(() => ({ stages: window.smartStages, downloadProgress: [...new Set(window.smartProgress)] }));
    assert(phases.stages.includes('loading') && phases.stages.includes('encoding'), JSON.stringify(phases));
    assert(phases.downloadProgress.some(value => value > 0 && value < 100), JSON.stringify(phases));
    const result = { phases, candidatesReusePredictions: true, undoPoint: true, backend, secure: await page.evaluate(() => isSecureContext), prepareMs, decodeMs, sourceSize: [768, 512], manualAndSmartUnion: true, negativePoint: true, undoRedo: true, subtract: true, export: true, modelErrorPreservesPainting: true, stopPreservesPainting: true, noExternalRequests: true, noGenerationRequests: true, output };
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
