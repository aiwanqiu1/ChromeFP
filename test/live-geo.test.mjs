import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CDP, launchChrome, killChrome, resolveChromePath, sleep } from '../lib/cdp.mjs';
import { lookupGeo } from '../lib/geo.mjs';

const profiles = {
  '203.0.113.10': { countryCode:'US',timezone:'America/New_York',lat:40.7,lon:-74,city:'New York' },
  '203.0.113.20': { countryCode:'JP',timezone:'Asia/Tokyo',lat:35.6,lon:139.6,city:'Tokyo' },
};
const ipquery = ip => ({ ip, isp:{isp:'Fixture ISP',org:'Fixture Org'},
  location:{country_code:profiles[ip].countryCode,country:profiles[ip].countryCode,
    city:profiles[ip].city,state:'Fixture',timezone:profiles[ip].timezone,
    latitude:profiles[ip].lat,longitude:profiles[ip].lon},risk:{is_proxy:true,is_datacenter:false} });

async function startProxy() {
  const fixture = { ip:'203.0.113.10', observations:{}, mismatch:false, hold:false, holdGeography:false,
    ipqueryError:null,ipqueryMismatch:false,ipapiMismatch:false,requests:[] };
  const sockets=new Set();
  const server=http.createServer((request,response)=>{
    const endpoint=new URL(request.url,'http://fixture.example');
    fixture.requests.push(endpoint.pathname+endpoint.search);
    if(fixture.hold)return;
    const pieces=endpoint.pathname.split('/').filter(Boolean);
    const host=pieces.shift();
    if(host==='api.ipquery.io'&&pieces.length&&fixture.holdGeography){fixture.onGeography?.();return}
    const observed=fixture.observations[host]||fixture.ip;
    const selected=pieces.length&&pieces[0]!=='json'?decodeURIComponent(pieces[0]):observed;
    const profile=profiles[selected];
    let body;
    if(host==='api.ipify.org')body={ip:observed};
    if(host==='api.ipquery.io')body=pieces.length&&fixture.ipqueryError?{error:fixture.ipqueryError}
      :ipquery(pieces.length?(fixture.mismatch||fixture.ipqueryMismatch?'203.0.113.20':selected):observed);
    if(host==='ipapi.co')body={ip:fixture.mismatch||fixture.ipapiMismatch?'203.0.113.20':selected,country_code:profile.countryCode,timezone:profile.timezone,latitude:profile.lat,longitude:profile.lon};
    if(host==='ipinfo.io')body={ip:fixture.mismatch?'203.0.113.20':selected,country:profile.countryCode,timezone:profile.timezone,loc:profile.lat+','+profile.lon};
    response.writeHead(body?200:404,{'content-type':'application/json','connection':'close','cache-control':'public,max-age=3600'});
    response.end(JSON.stringify(body||{error:'unknown fixture endpoint'}));
  });
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
  server.on('connect',(_request,socket)=>socket.destroy());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {...fixture, state:fixture, url:'http://127.0.0.1:'+server.address().port,
    async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))}};
}

function routeEndpoints() {
  const original=CDP.connect;
  const connections=[];
  const commands=[];
  CDP.connect=async (url,...args)=>{
    connections.push(url);
    const cdp=await original.call(CDP,url,...args);
    const send=cdp.send.bind(cdp);
    cdp.send=(method,params={},...rest)=>{
      const command={method,params,url};commands.push(command);
      if(['Page.navigate','Network.loadNetworkResource'].includes(method)&&params.url?.startsWith('https:')) {
        const endpoint=new URL(params.url);
        assert.ok(['ipapi.co','ipinfo.io','api.ipify.org','api.ipquery.io'].includes(endpoint.hostname));
        params={...params,url:'http://fixture.example/'+endpoint.hostname+endpoint.pathname+endpoint.search};
      }
      return send(method,params,...rest).then(result=>{command.result=result;return result});
    };
    return cdp;
  };
  return {connections,commands,restore(){CDP.connect=original}};
}

test('real Chrome geography follows the already open browser proxy and its live exit changes instead of a second browser', {timeout:60000}, async () => {
  const proxyA=await startProxy();const proxyB=await startProxy();proxyB.state.ip='203.0.113.20';
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'chromefp-live-geo-'));
  let launched,owner,route;
  try {
    launched=await launchChrome({exe:resolveChromePath(),userDataDir:directory,args:['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--proxy-server='+proxyA.url]});
    owner=await CDP.connect(launched.wsUrl);
    const originalTargets=(await owner.send('Target.getTargets')).targetInfos.filter(info=>info.type==='page').map(info=>info.targetId).sort();
    route=routeEndpoints();
    const assertClean=async()=>{
      const closed=new Set(route.commands.filter(command=>command.method==='Target.createTarget').map(command=>command.result?.targetId).filter(Boolean));
      const deadline=Date.now()+3000;
      let infos;
      do {
        infos=(await owner.send('Target.getTargets')).targetInfos;
        if(!infos.some(info=>closed.has(info.targetId)))break;
        await sleep(25);
      }while(Date.now()<deadline);
      assert.equal(infos.some(info=>closed.has(info.targetId)),false,'remove only lookup-owned hidden targets');
      assert.deepEqual(infos.filter(info=>info.type==='page').map(info=>info.targetId).sort(),originalTargets);
    };
    const options={wsUrl:launched.wsUrl,chromeExe:resolveChromePath(),proxyMode:'explicit',proxyUrl:proxyB.url,timeoutMs:5000,detectionTimeoutMs:5000};
    const first=await lookupGeo(options);
    assert.equal(first.ip,'203.0.113.10','must use the live Chrome proxy A even when launch options describe proxy B');
    assert.equal(first.timezone,'America/New_York');
    assert.ok(route.connections.every(url=>url===launched.wsUrl),'never start/connect a temporary browser in wsUrl mode');
    assert.equal(proxyB.state.requests.length,0,'stale launcher proxy settings must not redirect live lookup');
    const beforeSame=proxyA.state.requests.length;
    const same=await lookupGeo({...options,previousGeo:first});
    assert.equal(same.ip,first.ip);assert.equal(same.timezone,first.timezone);
    assert.equal(proxyA.state.requests.slice(beforeSame).some(url=>/^\/api\.ipquery\.io\/203\./.test(url)),false,'unchanged observed IP reuses its known geography, while both egress probes remain live');
    proxyA.state.ip='203.0.113.20';
    const next=await lookupGeo({...options,previousGeo:first});
    assert.equal(next.ip,'203.0.113.20');assert.equal(next.timezone,'Asia/Tokyo');assert.equal(next.isProxy,true);assert.equal(next.isHosting,false);
    assert.ok(proxyA.state.requests.includes('/api.ipquery.io/203.0.113.20?format=json'),'geography must explicitly query the newly observed IP');
    assert.equal((await owner.send('Browser.getVersion')).product.includes('Chrome/'),true);
    await assertClean();
    assert.ok(route.commands.some(command=>command.method==='Network.loadNetworkResource'));
    const created=route.commands.filter(command=>command.method==='Target.createTarget');
    assert.ok(created.length>0&&created.every(command=>command.params.hidden===true&&command.params.background===true),'all lookup targets must be invisible');
    assert.equal(route.commands.some(command=>command.method==='Browser.close'),false);

    proxyA.state.observations['api.ipquery.io']='203.0.113.10';
    const split=await lookupGeo(options);
    assert.equal(split.ip,'203.0.113.20','primary observed endpoint is stable despite response timing');
    assert.ok(split.egressWarning);assert.equal(new Set(split.egressObservations.filter(value=>value.ip).map(value=>value.ip)).size,2);
    const standalone=await lookupGeo({...options,wsUrl:undefined,proxyUrl:proxyA.url});
    assert.equal(standalone.ip,split.ip,'print-config and the open browser use the same observed-IP priority');
    assert.equal(standalone.egressSource,split.egressSource);assert.equal(standalone.source,split.source);
    proxyA.state.observations={};proxyA.state.ip='203.0.113.10';proxyA.state.ipqueryError='classification unavailable';
    const fallback=await lookupGeo(options);
    assert.equal(fallback.ip,'203.0.113.10');assert.equal(fallback.source,'ipapi.co');
    assert.equal(fallback.timezone,'America/New_York');assert.equal(fallback.isProxy,null);assert.match(fallback.detectionError,/classification unavailable/);
    proxyA.state.ipqueryError=null;proxyA.state.ipqueryMismatch=true;proxyA.state.ipapiMismatch=true;
    const secondFallback=await lookupGeo(options);
    assert.equal(secondFallback.ip,'203.0.113.10');assert.equal(secondFallback.source,'ipinfo.io');assert.equal(secondFallback.isHosting,null);assert.match(secondFallback.detectionError,/IP.*不一致/);
    proxyA.state.ipqueryMismatch=false;proxyA.state.ipapiMismatch=false;
    proxyA.state.observations={};proxyA.state.ip='203.0.113.10';proxyA.state.mismatch=true;
    await assert.rejects(lookupGeo(options),/IP.*不一致|不一致.*IP/);

    proxyA.state.mismatch=false;proxyA.state.hold=true;
    await assert.rejects(lookupGeo({...options,timeoutMs:300}),/超时|失败/);
    assert.equal(owner.closed,false);await assertClean();
    const abort=new AbortController();const aborted=lookupGeo({...options,signal:abort.signal,timeoutMs:5000});
    setTimeout(()=>abort.abort(new Error('fixture live lookup abort')),100);
    await assert.rejects(aborted,/fixture live lookup abort/);
    assert.equal(owner.closed,false);await assertClean();
    proxyA.state.hold=false;proxyA.state.holdGeography=true;
    const geographyAbort=new AbortController();const abortReason=new Error('fixture geography aborted');
    proxyA.state.onGeography=()=>geographyAbort.abort(abortReason);
    await assert.rejects(lookupGeo({...options,signal:geographyAbort.signal}),error=>error===abortReason);
    assert.equal(owner.closed,false);await assertClean();
  } finally {
    route?.restore();await owner?.send('Browser.close',{},undefined,1000).catch(()=>{});owner?.close();killChrome(launched?.proc);
    await proxyA.close();await proxyB.close();await sleep(300);
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
