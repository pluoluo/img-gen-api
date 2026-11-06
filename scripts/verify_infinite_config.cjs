const {chromium}=require('../canvas/node_modules/playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
(async()=>{const browser=await chromium.launch({headless:true});const results=[];
 try{for(const id of ['external','default']){
  const context=await browser.newContext();
  await context.addInitScript(channelId=>{
   const config={model:`${channelId}::custom-image`,imageModel:`${channelId}::custom-image`,textModel:`${channelId}::custom-text`,audioModel:`${channelId}::custom-audio`,channels:[{id:channelId,name:'自选渠道',baseUrl:'https://example.test',apiKey:'test-only',apiFormat:'openai',models:[{name:'custom-image',capability:'image'},{name:'custom-text',capability:'text'},{name:'custom-audio',capability:'audio'}]}]};
   localStorage.setItem('infinite-canvas:ai_config_store',JSON.stringify({state:{config}}));
  },id);
  const page=await context.newPage();await page.goto(`${process.env.INFINITE_TEST_URL||'http://127.0.0.1:8770'}/infinite/image`);await page.getByText('custom-image（自选渠道）',{exact:true}).waitFor();
  const config=await page.evaluate(()=>JSON.parse(localStorage.getItem('infinite-canvas:ai_config_store')).state.config);
  assert.equal(config.imageModel,`${id}::custom-image`);assert.equal(config.textModel,`${id}::custom-text`);assert.equal(config.audioModel,`${id}::custom-audio`);
  results.push({channelId:id,preserved:['image','text','audio']});await context.close();
 }}finally{await browser.close()}
 fs.writeFileSync('data/infinite-validation/config-result.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
})().catch(error=>{console.error(error);process.exit(1)});
