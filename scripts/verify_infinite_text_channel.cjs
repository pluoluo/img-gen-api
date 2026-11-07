// Exercise text-channel UI and generation with only placeholder credentials and intercepted providers.
const { chromium } = require('../canvas/node_modules/playwright');
const { assertOfflineValidation } = require('./infinite_test_environment.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const origin = process.env.INFINITE_TEST_URL || 'http://127.0.0.1:8770';
const output = 'data/infinite-validation';
const generatedPrompt = '一幅古典油画风格的花卉静物，盛开的花朵与绿叶构成画面主体，花瓣呈现层叠的厚涂笔触，暖色背景简洁柔和，左上方自然光照亮花瓣，色彩浓郁，明暗过渡细腻，不添加文字或水印。';
async function project(page) {
  return page.evaluate(() => new Promise(resolve => {
    const r = indexedDB.open('infinite-canvas');
    r.onsuccess = () => { const db = r.result, tx = db.transaction('app_state'), q = tx.objectStore('app_state').get('infinite-canvas:canvas_store'); q.onsuccess = () => resolve(JSON.parse(q.result || '{}').state?.projects[0]); tx.oncomplete = () => db.close(); };
  }));
}
(async () => {
  await assertOfflineValidation(origin);
  execFileSync('venv/bin/python', ['-c', `import json,zipfile
node=dict(id='text-test',type='text',title='文本渠道验收节点',position=dict(x=100,y=50),width=300,height=240,metadata=dict(content='',status='idle'))
project=dict(id='text-channel-test',title='文本渠道验收',nodes=[node,dict(id='image-test',type='image',title='生图输入验收',position=dict(x=550,y=50),width=300,height=240,metadata=dict(status='idle',model='image-api::gpt-image-2.5-flare',count=1))],connections=[dict(id='text-to-image',fromNodeId='text-test',toNodeId='image-test')],chatSessions=[],activeChatId=None,backgroundMode='dots',showImageInfo=True,viewport=dict(x=300,y=200,k=1))
with zipfile.ZipFile('data/infinite-validation/text-channel.zip','w') as z:z.writestr('projects.json',json.dumps(dict(app='infinite-canvas',version=3,projects=[dict(project=project,files=[])])))`]);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    const errors = [], submissions = [], imageSubmissions = [], otherPosts = [];
    let failNext = false;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && !request.url().startsWith(origin + '/api/v1/infinite/mimo/') && !request.url().endsWith('/api/v1/infinite/generate')) otherPosts.push(request.url()); });
    await page.route('https://*.xiaomimimo.com/**', route => route.abort());
    await page.route('**/api/v1/infinite/mimo/**', async route => {
      const headers = {}; // Same-origin forwarding must work without supplier CORS headers.
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const url = route.request().url(), body = route.request().postDataJSON(); submissions.push({ url, body });
      if (failNext) return route.fulfill({ status: 403, json: { error: { message: "测试模型无权限" } } });
      if (url.endsWith('/chat/completions')) return route.fulfill({ headers: { ...headers, 'content-type': 'text/event-stream' }, body: 'data: ' + JSON.stringify({ choices: [{ delta: { content: generatedPrompt } }] }) + '\n\ndata: [DONE]\n\n' });
      if (url.endsWith('/responses')) return route.fulfill({ headers: { ...headers, 'content-type': 'text/event-stream' }, body: 'data: {"type":"response.output_text.delta","delta":"显式 Responses 成功"}\n\ndata: [DONE]\n\n' });
      return route.abort();
    });
    await page.route('**/api/v1/infinite/generate', async route => { imageSubmissions.push(route.request().postDataJSON()); await route.fulfill({ json: { task_id: 'text-prompt-image' } }); });
    await page.route('**/api/v1/tasks/text-prompt-image', route => route.fulfill({ json: { status: 'completed', images: [{ base64: fs.readFileSync(output + '/fixture.png').toString('base64') }] } }));
    await page.goto(origin + '/infinite/config');
    await page.getByRole('heading', { name: '配置与用户偏好', exact: true }).waitFor();
    await page.evaluate(() => {
      const key = 'infinite-canvas:ai_config_store', saved = JSON.parse(localStorage.getItem(key));
      saved.state.config.channels.push({ id: 'mimo-test', name: 'MiMo 文本验收', baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', apiFormat: 'openai', apiKey: 'test-placeholder', models: [{ name: 'mimo-v2.6-pro', capability: 'text' }] });
      saved.state.config.channels.push({ id: 'audio-test', name: '用户音频渠道', baseUrl: 'https://audio.example/v1', apiFormat: 'openai', apiKey: 'test-placeholder', models: [{ name: 'tts-test', capability: 'audio' }] });
      saved.state.config.systemPrompt = '保留用户品牌的原始文案。'; saved.state.config.textModel = 'mimo-test::mimo-v2.6-pro'; saved.state.config.audioModel = 'audio-test::tts-test'; saved.state.config.proxyEnabled = true; saved.state.config.proxyUrl = "http://127.0.0.1:23210"; saved.state.config.nodeRegenerateBehavior = 'overwrite';
      localStorage.setItem(key, JSON.stringify(saved));
    });
    await page.reload();
    const openChannel = async () => {
      await page.getByText('MiMo 文本验收', { exact: true }).locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]').getByRole('button', { name: '编辑', exact: true }).click();
      return page.getByRole('dialog').filter({ has: page.getByText('文本接口', { exact: true }) });
    };
    let drawer = await openChannel();
    await drawer.getByText('文本接口', { exact: true }).waitFor();
    await page.screenshot({ path: output + '/text-channel-desktop.png', animations: 'disabled' });
    await drawer.getByRole('button', { name: /保\s*存/ }).click();
    await page.goto(origin + '/infinite/canvas');
    const chooser = page.waitForEvent('filechooser'); await page.getByRole('button', { name: '导入画布', exact: true }).click(); await (await chooser).setFiles(output + '/text-channel.zip');
    await page.getByRole('heading', { name: '文本渠道验收', exact: true }).click();
    const projectUrl = page.url();
    const generate = async prompt => {
      await page.locator('[data-node-id="text-test"]').click(); await page.getByRole('button', { name: 'AI 文本生成', exact: true }).click();
      const panel = page.locator('[data-node-panel="text-test"]'); await panel.getByRole('textbox').fill(prompt); await panel.getByRole('button', { name: '生成', exact: true }).click();
    };
    const savedText = async expected => {
      for (let i = 0; i < 80; i++) { const value = await project(page); if (value?.nodes.find(node => node.id === 'text-test')?.metadata?.content === expected) return; await page.waitForTimeout(100); }
      throw Error('Text result not persisted: ' + expected);
    };
    await generate('画一幅油画风格的花卉'); await savedText(generatedPrompt);
    assert.equal(submissions.length, 1); assert.equal(submissions[0].url, origin + '/api/v1/infinite/mimo/token-plan-cn/v1/chat/completions'); assert.equal(submissions[0].body.model, 'mimo-v2.6-pro'); assert.ok(submissions[0].body.messages.some(message => JSON.stringify(message).includes('画一幅油画风格的花卉'))); assert.equal(submissions[0].body.input, undefined);
    const systemMessage = submissions[0].body.messages.find(message => message.role === 'system').content;
    assert.ok(systemMessage.startsWith('保留用户品牌的原始文案。'));
    for (const rule of ['GPT Image 2.5', '只输出最终提示词正文', '逐字引用', '沿用已有编号', '只修改什么', '<image_gen>']) assert.ok(systemMessage.includes(rule), rule);
    await page.reload(); await page.locator('[data-node-id="text-test"]').getByText(generatedPrompt, { exact: true }).waitFor();
    await page.locator('[data-node-id="image-test"]').click();
    const imagePanel = page.locator('[data-node-panel="image-test"]');
    await imagePanel.getByRole('button', { name: '生成', exact: true }).click();
    for (let i = 0; i < 80 && !imageSubmissions.length; i++) await page.waitForTimeout(100);
    assert.equal(imageSubmissions.length, 1);
    assert.ok(imageSubmissions[0].prompt.includes(generatedPrompt));
    assert.ok(!imageSubmissions[0].prompt.includes('你是画布中的生图提示词编写器'));
    assert.ok(!imageSubmissions[0].prompt.includes('<image_gen>'));
    for (let i = 0; i < 80; i++) { const image = (await project(page)).nodes.find(n => n.id === 'image-test'); if (image.metadata?.content) break; await page.waitForTimeout(100); }

    await page.goto(origin + '/infinite/config'); drawer = await openChannel();
    await drawer.getByText('文本接口', { exact: true }).locator('..').getByRole('combobox').click(); await page.getByTitle('Responses', { exact: true }).click();
    await drawer.getByRole('button', { name: /保\s*存/ }).click(); await page.reload(); drawer = await openChannel();
    await drawer.getByText('Responses', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: output + '/text-channel-mobile.png', animations: 'disabled' });
    await drawer.getByRole('button', { name: /保\s*存/ }).click();
    await page.setViewportSize({ width: 1500, height: 1000 }); await page.goto(projectUrl);
    await generate('改写这句话'); await savedText('显式 Responses 成功');
    assert.equal(submissions.length, 2); assert.equal(submissions[1].url, origin + '/api/v1/infinite/mimo/token-plan-cn/v1/responses'); assert.ok(submissions[1].body.input); assert.ok(submissions[1].body.input.find(m => m.role === 'system').content.includes('GPT Image 2.5')); assert.equal(submissions[1].body.messages, undefined);
    const preserved = await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('infinite-canvas:ai_config_store')).state.config; return { text: c.textModel, audio: c.audioModel, image: c.imageModel, protocol: c.channels.find(x => x.id === 'mimo-test').textApiFormat, audioPresent: c.channels.some(x => x.id === 'audio-test') }; });
    assert.equal(preserved.text, 'mimo-test::mimo-v2.6-pro'); assert.equal(preserved.audio, 'audio-test::tts-test'); assert.equal(preserved.protocol, 'responses'); assert.equal(preserved.audioPresent, true); assert.ok(preserved.image.startsWith('image-api::'));
    await page.reload(); failNext = true; await generate('模拟失败以验证错误保留');
    let failed;
    for (let i = 0; i < 80; i++) { failed = (await project(page))?.nodes.find(n => n.id === 'text-test'); if (failed?.metadata?.status === 'error') break; await page.waitForTimeout(100); }
    assert.equal(failed.metadata.errorDetails, '测试模型无权限');
    await page.locator('[data-node-id="text-test"]').getByText('测试模型无权限', { exact: true }).waitFor();
    await page.screenshot({ path: output + '/text-channel-error.png', animations: 'disabled' });
    assert.equal(submissions.length, 3);
    assert.deepEqual(otherPosts, []); assert.deepEqual(errors, []);
    const result = { imagePromptContractOnChatAndResponses: true, customSystemPromptPreserved: true, generatedPromptFeedsImageNode: true, promptRoleNotLeakedIntoImageRequest: true, mockedImageRequests: imageSubmissions.length, mimoAutoChat: true, sameOriginRelay: true, bypassesUnreachableLocalProxy: true, nodeRetainsProviderError: true, baseUrlV1Preserved: true, streamingResultOnNode: true, resultSurvivesReload: true, explicitResponsesPersists: true, responsesStillWorks: true, userAudioAndTextPreserved: true, imageRoutingPreserved: true, mockedRequests: submissions.map(s => s.url), otherPostRequests: otherPosts, browserErrors: errors };
    fs.writeFileSync(output + '/text-channel-result.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
