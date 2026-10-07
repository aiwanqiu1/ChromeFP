import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { CDP, launchChrome, killChrome, resolveChromePath, sleep } from '../lib/cdp.mjs';
import { runDriver } from '../lib/driver.mjs';
import { buildProvider } from '../lib/provider.mjs';

test('provider hot updates use one private installation and update language, Intl, hardware and Canvas seed', () => {
  const context = vm.createContext({});
  vm.runInContext(`
    globalThis.Navigator=class Navigator {};globalThis.navigator=new Navigator();
    globalThis.HTMLCanvasElement=class Canvas {
      constructor(){this.width=8;this.height=8;this.pixels=new Uint8ClampedArray(256).fill(100)}
      getContext(){return new CanvasRenderingContext2D(this)}
      toDataURL(){return Array.from(this.pixels).join(',')}
    };
    globalThis.CanvasRenderingContext2D=class Context {
      constructor(canvas){this.canvas=canvas}
      getImageData(){return {width:8,height:8,data:this.canvas.pixels.slice()}}
      putImageData(image){this.canvas.pixels.set(image.data)}
    };
    globalThis.document={createElement:()=>new HTMLCanvasElement()};globalThis.location={protocol:'https:'};
  `, context);
  const before = Array.from(vm.runInContext('Reflect.ownKeys(globalThis)', context));
  vm.runInContext(buildProvider({locale:'ja-JP',acceptLanguage:'ja-JP,ja,en',hardwareConcurrency:8,
    deviceMemory:8,canvasNoise:true,noiseSeed:12345}, 'shared-installation'), context);
  const wrappers = vm.runInContext('[Function.prototype.toString,CanvasRenderingContext2D.prototype.getImageData,HTMLCanvasElement.prototype.toDataURL]', context);
  const first = vm.runInContext('new HTMLCanvasElement().toDataURL()', context);
  vm.runInContext(buildProvider({locale:'de-DE',acceptLanguage:'de-DE,de,en',hardwareConcurrency:4,
    deviceMemory:4,canvasNoise:true,noiseSeed:54321}, 'shared-installation'), context);
  assert.equal(vm.runInContext('navigator.language', context), 'de-DE');
  assert.deepEqual(Array.from(vm.runInContext('navigator.languages', context)), ['de-DE','de','en']);
  assert.equal(vm.runInContext('Intl.DateTimeFormat().resolvedOptions().locale', context), 'de-DE');
  assert.equal(vm.runInContext('Intl.NumberFormat().resolvedOptions().locale', context), 'de-DE');
  assert.equal(vm.runInContext('new Intl.DateTimeFormat("en-GB").resolvedOptions().locale', context), 'en-GB');
  assert.equal(vm.runInContext('navigator.hardwareConcurrency', context), 4);
  assert.equal(vm.runInContext('navigator.deviceMemory', context), 4);
  for (const [index,expression] of ['Function.prototype.toString','CanvasRenderingContext2D.prototype.getImageData','HTMLCanvasElement.prototype.toDataURL'].entries())
    assert.equal(vm.runInContext(expression,context),wrappers[index]);
  const second = vm.runInContext('new HTMLCanvasElement().toDataURL()', context);
  assert.notEqual(second, first);
  assert.equal(vm.runInContext('new HTMLCanvasElement().toDataURL()', context), second);
  assert.deepEqual(Array.from(vm.runInContext('Reflect.ownKeys(globalThis)', context)), before);
});

const oldConfig = {timezoneId:'Asia/Tokyo',locale:'ja-JP',acceptLanguage:'ja-JP,ja,en-US,en',
  hardwareConcurrency:8,deviceMemory:8,canvasNoise:true,audioNoise:true,noiseSeed:12345};
const nextConfig = {...oldConfig,timezoneId:'Europe/Berlin',locale:'de-DE',acceptLanguage:'de-DE,de,en-US,en',
  hardwareConcurrency:4,deviceMemory:4,noiseSeed:54321};
const environment = `({language:navigator.language,languages:Array.from(navigator.languages),
  locale:Intl.DateTimeFormat().resolvedOptions().locale,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,
  cores:navigator.hardwareConcurrency,memory:navigator.deviceMemory,ua:navigator.userAgent,
  hints:navigator.userAgentData?.toJSON()})`;
async function until(check) {
  const deadline=Date.now()+8000;
  while(Date.now()<deadline){if(await check())return;await sleep(50)}
  assert.fail('live browser result did not become ready');
}

test('real Chrome updates an open page, same-process iframe, OOPIF and persistent Worker without reload, then new tabs inherit', {timeout:90000}, async () => {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'chromefp-live-driver-'));
  const server=http.createServer((request,response)=>{
    if(request.url==='/headers'){response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(request.headers));return}
    if(request.url==='/worker.js'){response.writeHead(200,{'content-type':'application/javascript'});response.end(`onmessage=()=>postMessage(${environment})`);return}
    response.writeHead(200,{'content-type':'text/html','accept-ch':'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness'});
    response.end(`<!doctype html><script>window.first=${environment};window.loadCount=(Number(sessionStorage.loadCount)||0)+1;sessionStorage.loadCount=window.loadCount</script><body>live</body>`);
  });
  await new Promise(resolve=>server.listen(0,'0.0.0.0',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/';
  let launched,driver;
  const scripts=new Map();
  const original=CDP.prototype.send;
  CDP.prototype.send=function(method,params={},sessionId,timeout){
    const records=scripts.get(sessionId)||new Map();scripts.set(sessionId,records);
    return original.call(this,method,params,sessionId,timeout).then(result=>{
      if(method==='Page.addScriptToEvaluateOnNewDocument')records.set(result.identifier,params.source);
      if(method==='Page.removeScriptToEvaluateOnNewDocument')records.delete(params.identifier);
      return result;
    });
  };
  try{
    launched=await launchChrome({exe:resolveChromePath(),userDataDir:temporary,args:['--headless=new','--no-startup-window','--no-first-run','--no-default-browser-check','--disable-sync','--no-proxy-server','--lang=ja-JP','--accept-lang=ja-JP,ja,en-US,en']});
    driver=await runDriver({wsUrl:launched.wsUrl,cfg:oldConfig});
    assert.equal(typeof driver.updateConfig,'function','open browser needs a live config update API');
    const read=async(target,expression)=>{
      const result=await driver.cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},driver.sessionByTarget.get(target));
      assert.equal(result.exceptionDetails,undefined,result.exceptionDetails?.text);return result.result.value;
    };
    const target=await driver.openUrl(url);await until(async()=>!!await read(target,'window.first'));
    const initial=await read(target,environment);
    assert.ok(initial.hints.brands.some(row=>row.brand==='Chromium'),'automatic language override must retain native Client Hints');
    assert.equal(initial.hints.platform,'Windows');
    await read(target,`window.savedWrappers=[Function.prototype.toString,HTMLCanvasElement.prototype.toDataURL];
      window.cookieBefore='keep-login';document.cookie='session=keep-login';
      window.canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;canvas.getContext('2d').fillStyle='rgb(100,100,100)';canvas.getContext('2d').fillRect(0,0,16,16);
      window.oldCanvas=canvas.toDataURL();
      window.worker=new Worker('/worker.js');
      window.workerRead=()=>new Promise(resolve=>{worker.onmessage=e=>resolve(e.data);worker.postMessage(1)});
      const frame=document.createElement('iframe');frame.id='same';frame.src='${url}?same';document.body.append(frame);
      const other=document.createElement('iframe');other.src='${url.replace('127.0.0.1','localhost')}?oopif';document.body.append(other);`);
    await until(async()=>await read(target,'Boolean(document.querySelector("#same").contentWindow.first)'));
    await read(target,`(async()=>{
      const offline=new OfflineAudioContext(1,4096,44100);
      const oscillator=offline.createOscillator();oscillator.type='triangle';oscillator.frequency.value=10000;
      const compressor=offline.createDynamicsCompressor();oscillator.connect(compressor);compressor.connect(offline.destination);oscillator.start();
      window.renderedAudio=await offline.startRendering();window.oldSamples=Array.from(renderedAudio.getChannelData(0));
      window.audioRead=()=>Array.from(renderedAudio.getChannelData(0));
      window.audioWrappers=[AudioBuffer.prototype.getChannelData,AudioBuffer.prototype.copyFromChannel];
      const nativeWritable=new AudioBuffer({length:16,sampleRate:44100,numberOfChannels:1});
      const shared=nativeWritable.getChannelData(0);shared.fill(.75);
      if(nativeWritable.getChannelData(0)!==shared||!shared.every(value=>Math.abs(value-.75)<1e-6))throw new Error('AudioBuffer writable identity lost');
    })()`);
    await read(target,'workerRead()');
    let iframe;await until(async()=>{iframe=(await driver.cdp.send('Target.getTargets')).targetInfos.find(info=>info.type==='iframe');return !!iframe});
    await driver.waitForTarget(iframe.targetId);
    await driver.updateConfig(nextConfig);
    const check=value=>{
      assert.equal(value.language,'de-DE');assert.deepEqual(value.languages,['de-DE','de','en-US','en']);
      assert.equal(value.locale,'de-DE');assert.equal(value.timezone,'Europe/Berlin');
      assert.equal(value.cores,4);assert.equal(value.memory,4);assert.equal(value.ua,initial.ua);
      if(value.hints)assert.deepEqual(value.hints,initial.hints);
    };
    check(await read(target,environment));check(await read(iframe.targetId,environment));check(await read(target,'workerRead()'));
    check(await read(target,`document.querySelector('#same').contentWindow.eval(${JSON.stringify(environment)})`));
    assert.equal(await read(target,'window.loadCount'),1);assert.equal(await read(target,'document.cookie.includes("session=keep-login")'),true);
    assert.equal(await read(target,'savedWrappers[0]===Function.prototype.toString&&savedWrappers[1]===HTMLCanvasElement.prototype.toDataURL'),true);
    assert.equal(await read(target,'oldCanvas!==canvas.toDataURL()'),true);
    assert.equal(await read(target,'audioWrappers[0]===AudioBuffer.prototype.getChannelData&&audioWrappers[1]===AudioBuffer.prototype.copyFromChannel'),true);
    const audio=await read(target,`(()=>{
      const latest=audioRead();const again=audioRead();
      const copy=new Float32Array(20).fill(37);renderedAudio.copyFromChannel(copy,0,4090);
      return {changed:latest.some((value,index)=>value!==oldSamples[index]),stable:latest.every((value,index)=>value===again[index]),
        copyMatches:Array.from(copy.slice(0,6)).every((value,index)=>value===latest[4090+index]),tail:Array.from(copy.slice(6)).every(value=>value===37)};
    })()`);
    assert.deepEqual(audio,{changed:true,stable:true,copyMatches:true,tail:true});
    const headers=await read(target,'fetch("/headers").then(r=>r.json())');
    assert.ok(headers['accept-language'].startsWith('de-DE'));
    assert.ok(headers['sec-ch-ua'].includes('Chromium'));assert.equal(headers['sec-ch-ua-platform'],'"Windows"');
    assert.ok(headers['sec-ch-ua-full-version-list'].includes(driver.version.product.split('/')[1]));
    for(const records of scripts.values())assert.ok(records.size<=1,'old document scripts must be removed');
    const fresh=await driver.openUrl(url+'?fresh');await until(async()=>!!await read(fresh,'window.first'));check(await read(fresh,'window.first'));
    await driver.cdp.send('Page.navigate',{url:url+'?navigated'},driver.sessionByTarget.get(target));await until(async()=>await read(target,'location.search')==='?navigated'&&!!await read(target,'window.first'));check(await read(target,'window.first'));
  }finally{
    CDP.prototype.send=original;
    if(driver&&!driver.cdp.closed)await driver.cdp.send('Browser.close',{},undefined,1000).catch(()=>{});
    driver?.cdp.close();killChrome(launched?.proc);
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});await sleep(300);
    assert.equal(path.dirname(path.resolve(temporary)),path.resolve(os.tmpdir()));fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
