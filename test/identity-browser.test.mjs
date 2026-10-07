import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CDP, launchChrome, killChrome, resolveChromePath, sleep } from '../lib/cdp.mjs';
import { runDriver } from '../lib/driver.mjs';
import { parseArgs } from '../lib/options.mjs';
import { startVerifyServer } from '../lib/verifypage.mjs';

const page = `<!doctype html><script>
window.firstIdentity={ua:navigator.userAgent,platform:navigator.platform,low:navigator.userAgentData.toJSON(),
 width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,dpr:devicePixelRatio,
 language:navigator.language};
window.highIdentity=navigator.userAgentData.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','wow64','formFactors']);
</script><body>ready</body>`;
const fingerprintHeaders = request => Object.fromEntries(Object.entries(request.headers).filter(([name]) =>
 name === 'user-agent' || name === 'accept-language' || name.startsWith('sec-ch-ua')));
async function until(check, timeout = 8000) {
 const deadline = Date.now()+timeout;
 while(Date.now()<deadline){if(await check())return;await sleep(50)}
 assert.fail('identity page was not ready');
}

test('real Chrome keeps UA, Client Hints, metrics and private installation coherent', {timeout:90000,skip:process.platform!=='win32'||process.arch!=='x64'}, async t => {
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'chromefp-identity-browser-'));
 const initialRequests=[];
 const server=http.createServer((request,response)=>{
  const headers={'accept-ch':'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, Sec-CH-UA-WoW64, Sec-CH-UA-Model, Sec-CH-UA-Form-Factors'};
  if(request.url.startsWith('/headers')){
   response.writeHead(200,{...headers,'content-type':'application/json'});response.end(JSON.stringify(fingerprintHeaders(request)));
  }else if(request.url==='/worker.js'){
   response.writeHead(200,{...headers,'content-type':'application/javascript'});
   response.end(`onmessage=async()=>postMessage({ua:navigator.userAgent,platform:navigator.platform,
    low:navigator.userAgentData.toJSON(),high:await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','platformVersion','fullVersionList','wow64','formFactors']),
    headers:await fetch('/headers').then(r=>r.json())})`);
  }else{
   initialRequests.push({url:request.url,headers:fingerprintHeaders(request)});
   response.writeHead(200,{...headers,'content-type':'text/html'});response.end(page);
  }
 });
 await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
 const url='http://127.0.0.1:'+server.address().port+'/';
 const scripts=new Map();
 const sendOriginal=CDP.prototype.send;
 CDP.prototype.send=function(method,params={},sessionId,timeoutMs){
  if(method==='Page.addScriptToEvaluateOnNewDocument')scripts.set(sessionId,params.source);
  return sendOriginal.call(this,method,params,sessionId,timeoutMs);
 };
 let launched,driver,verification,nativeGeometry;
 try{
  const options=parseArgs(['--identity',path.resolve('examples/windows-identity.json'),'--viewport','1200x720','--screen','1600x900','--dpr','1.25']);
  launched=await launchChrome({exe:resolveChromePath(),userDataDir:temporary,args:['--headless=new','--no-startup-window','--no-first-run','--no-default-browser-check','--disable-sync','--no-proxy-server','--lang=ja-JP','--accept-lang=ja-JP,ja,en-US,en']});
  const nativeClient=await CDP.connect(launched.wsUrl);
  try {
   const initial=await nativeClient.send('Target.createTarget',{url:'about:blank'});
   const session=await nativeClient.send('Target.attachToTarget',{targetId:initial.targetId,flatten:true});
   const raw=await nativeClient.send('Runtime.evaluate',{expression:'({screenWidth:screen.width,screenHeight:screen.height,dpr:devicePixelRatio})',returnByValue:true},session.sessionId);
   nativeGeometry=raw.result.value;
  }finally{nativeClient.close()}
  driver=await runDriver({wsUrl:launched.wsUrl,cfg:{timezoneId:'Asia/Tokyo',locale:'ja-JP',acceptLanguage:'ja-JP,ja,en-US,en',
   identity:options.identity,deviceMetrics:options.deviceMetrics,deviceMemory:8,canvasNoise:true,noiseSeed:12345}});
  const version=driver.version.product.split('/')[1];const major=version.split('.')[0];
  const read=async(target,expression)=>{
   const result=await driver.cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},driver.sessionByTarget.get(target));
   assert.equal(result.exceptionDetails,undefined,result.exceptionDetails?.text);return result.result.value;
  };
  const checkUA=(value)=>{
   assert.match(value.ua,new RegExp('Chrome/'+major+'\\.0\\.0\\.0'));assert.equal(value.platform,'Win32');
   assert.equal(value.low.platform,'Windows');assert.equal(value.low.mobile,false);
   for(const name of ['Chromium','Google Chrome'])assert.equal(value.low.brands.find(row=>row.brand===name)?.version,major);
  };
  const checkHigh=(value)=>{
   assert.deepEqual(value.formFactors,['Desktop']);assert.equal(value.platformVersion,'13.0.0');assert.equal(value.architecture,'x86');assert.equal(value.bitness,'64');assert.equal(value.wow64,false);
   for(const name of ['Chromium','Google Chrome'])assert.equal(value.fullVersionList.find(row=>row.brand===name)?.version,version);
  };
  let target;
  await t.test('the first script and first request have matching identity, language and device metrics',async()=>{
   target=await driver.openUrl(url+'?first');await until(async()=>!!await read(target,'window.firstIdentity'));
   const first=await read(target,'window.firstIdentity');checkUA(first);checkHigh(await read(target,'window.highIdentity'));
   assert.equal(first.language,'ja-JP');assert.deepEqual([first.width,first.height,first.screenWidth,first.screenHeight,first.dpr],[1200,720,1600,900,1.25]);
   const headers=initialRequests.find(row=>row.url==='/?first').headers;
   assert.equal(headers['user-agent'],first.ua);assert.match(headers['sec-ch-ua-platform'],/Windows/);assert.equal(headers['sec-ch-ua-mobile'],'?0');
   assert.ok(headers['accept-language'].startsWith('ja-JP'));
   assert.equal(await read(target,'matchMedia("(resolution: 1.25dppx)").matches'),true);
   const later=await read(target,'fetch("/headers").then(r=>r.json())');
   assert.match(later['sec-ch-ua-full-version-list'],new RegExp(version.replaceAll('.','\\.')));assert.equal(later['sec-ch-ua-arch'],'"x86"');assert.equal(later['sec-ch-ua-bitness'],'"64"');
  });
  await t.test('new user tabs are covered before their first script',async()=>{
   await driver.cdp.send('Runtime.evaluate',{expression:`window.open('${url}?popup','_blank')`,userGesture:true},driver.sessionByTarget.get(target));
   let popup;await until(async()=>{popup=(await driver.cdp.send('Target.getTargets')).targetInfos.find(info=>info.url===url+'?popup');return !!popup});
   await driver.waitForTarget(popup.targetId);await until(async()=>!!await read(popup.targetId,'window.firstIdentity'));
   const first=await read(popup.targetId,'window.firstIdentity');checkUA(first);assert.equal(first.width,1200);assert.equal(first.dpr,1.25);
  });
  await t.test('Worker JS and requests keep the page identity and high entropy values',async()=>{
   const worker=await read(target,`(async()=>{const worker=new Worker('/worker.js');try{return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('worker identity timeout')),7000);worker.onmessage=e=>{clearTimeout(timer);resolve(e.data)};worker.onerror=e=>reject(new Error(e.message));worker.postMessage(1);
   })}finally{worker.terminate()}})()`);
   checkUA(worker);checkHigh(worker.high);assert.equal(worker.headers['user-agent'],worker.ua);
   // 当前 Chrome 原生 Worker fetch 不发送 CH；未来若返回这些头，其值也必须一致。
   if(worker.headers['sec-ch-ua-platform'])assert.equal(worker.headers['sec-ch-ua-platform'],'"Windows"');
   if(worker.headers['sec-ch-ua-mobile'])assert.equal(worker.headers['sec-ch-ua-mobile'],'?0');
   if(worker.headers['sec-ch-ua-full-version-list'])assert.match(worker.headers['sec-ch-ua-full-version-list'],new RegExp(version.replaceAll('.','\\.')));
  });
  await t.test('OOPIF identity is covered while native geometry retains the documented emulation boundary',async()=>{
   await driver.cdp.send('Target.activateTarget',{targetId:target});
   const childURL=url.replace('127.0.0.1','localhost')+'?child';
   await read(target,`const frame=document.createElement('iframe');frame.style='width:320px;height:180px;border:0';frame.src='${childURL}';document.body.append(frame);`);
   let child;await until(async()=>{child=(await driver.cdp.send('Target.getTargets')).targetInfos.find(info=>info.type==='iframe'&&info.url===childURL);return !!child});
   await driver.waitForTarget(child.targetId);await until(async()=>!!await read(child.targetId,'window.firstIdentity'));
   const first=await read(child.targetId,'window.firstIdentity');checkUA(first);checkHigh(await read(child.targetId,'window.highIdentity'));
   await until(async()=>await read(child.targetId,"innerWidth")===320 && await read(child.targetId,"innerHeight")===180);
   const geometry=await read(child.targetId,"({width:innerWidth,height:innerHeight,screenWidth:screen.width,screenHeight:screen.height,dpr:devicePixelRatio})");
   assert.deepEqual([geometry.width,geometry.height],[320,180]);assert.deepEqual([geometry.screenWidth,geometry.screenHeight,geometry.dpr],[nativeGeometry.screenWidth,nativeGeometry.screenHeight,nativeGeometry.dpr]);
  });
  await t.test('the verification page compares configured identity and virtual geometry',async()=>{
   verification=await startVerifyServer({ip:'203.0.113.1',countryCode:'JP',timezone:'Asia/Tokyo',locale:'ja-JP',
    identity:driver.identity,deviceMetrics:options.deviceMetrics,overrideGeolocation:false,webrtcProtect:false});
   const id=await driver.openUrl(verification.url);
   await until(async()=>await read(id,'document.querySelectorAll("#consistency tr").length > 0'));
   const matches=await read(id,'Array.from(document.querySelectorAll("#consistency tr")).filter(row=>["UA / 请求头","Client Hints 低熵","Client Hints 高熵","视口 / 屏幕 / DPR"].includes(row.cells[0].textContent)).map(row=>({name:row.cells[0].textContent,ok:!row.querySelector(".bad,.warn")}))');
   assert.equal(matches.length,4);assert.equal(matches.every(row=>row.ok),true);
  });
  await t.test('repeating the actual injected source does not wrap prototypes twice or expose a global marker',async()=>{
   const before=await read(target,`window.savedToString=Function.prototype.toString;window.savedCanvas=HTMLCanvasElement.prototype.toDataURL;
    window.savedOwnKeys=null;window.savedOwnKeys=Reflect.ownKeys(globalThis).map(String);true`);
   assert.equal(before,true);const source=scripts.get(driver.sessionByTarget.get(target));assert.ok(source);
   await read(target,source);await read(target,source);
   const state=await read(target,`({sameString:Function.prototype.toString===savedToString,sameCanvas:HTMLCanvasElement.prototype.toDataURL===savedCanvas,
    marker:Reflect.ownKeys(globalThis).some(key=>String(key).includes('ChromeFP.provider.installed')),
    unchanged:Reflect.ownKeys(globalThis).map(String).join('|')===savedOwnKeys.join('|')})`);
   assert.deepEqual(state,{sameString:true,sameCanvas:true,marker:false,unchanged:true});
  });
 }finally{
  CDP.prototype.send=sendOriginal;
  if(verification)await verification.close();
  if(driver&&!driver.cdp.closed)await driver.cdp.send('Browser.close',{},undefined,1000).catch(()=>{});
  driver?.cdp.close();killChrome(launched?.proc);await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});await sleep(300);
  assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 }
});