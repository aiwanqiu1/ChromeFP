import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startVerifyServer } from '../lib/verifypage.mjs';

test('verification pushes the latest IP to connected pages and closes the event stream with the session', async () => {
  const first = { ip: '203.0.113.1', fingerprintId: 'first', ipMonitorSeconds: 30 };
  const next = { ...first, ip: '203.0.113.2', fingerprintId: 'second' };
  const server = await startVerifyServer(first);
  let reader;
  try {
    const response = await fetch(server.url + 'events');
    assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    async function receive() {
      while (!buffered.includes('\n\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffered += decoder.decode(chunk.value, { stream: true });
      }
      const end = buffered.indexOf('\n\n');
      const payload = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      return JSON.parse(payload.slice('data: '.length));
    }
    assert.deepEqual(await receive(), first);
    server.update(next);
    assert.deepEqual(await receive(), next);
    assert.deepEqual(await (await fetch(server.url + 'state')).json(), next);
    const html = await (await fetch(server.url)).text();
    assert.ok(html.includes('let EXPECT = ' + JSON.stringify(next)));
    const closed = reader.read();
    await server.close();
    assert.equal((await closed).done, true);
    await assert.rejects(fetch(server.url));
  } finally {
    await reader?.cancel();
    await server.close();
  }
});
