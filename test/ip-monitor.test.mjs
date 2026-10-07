import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startIPMonitor } from '../lib/ip-monitor.mjs';

const firstGeo = {
  ip: '203.0.113.1', countryCode: 'US', timezone: 'America/New_York',
  lat: 40.7, lon: -74, city: 'New York',
};
const secondGeo = {
  ip: '203.0.113.2', countryCode: 'JP', timezone: 'Asia/Tokyo',
  lat: 35.6, lon: 139.6, city: 'Tokyo',
};
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

function monitor(t, options) {
  const active = startIPMonitor({ initialGeo: firstGeo, intervalMs: 60000, ...options });
  t.after(() => active.stop());
  return active;
}

test('IP monitoring keeps the startup geography until an explicit or scheduled check', async t => {
  let lookups = 0;
  const changes = [];
  const active = monitor(t, {
    lookup: async () => { lookups++; return secondGeo; },
    onChange: async geo => { changes.push(geo); },
  });
  await tick();
  assert.equal(lookups, 0, 'startup already looked up the current IP');
  await active.checkNow();
  assert.equal(lookups, 1);
  assert.deepEqual(changes, [secondGeo]);
});

test('concurrent checks share one lookup and wait for the fingerprint update', async t => {
  const lookupResult = deferred();
  const applied = deferred();
  const applying = deferred();
  let lookups = 0;
  let changes = 0;
  let finished = false;
  const active = monitor(t, {
    lookup: async () => { lookups++; return lookupResult.promise; },
    onChange: async () => {
      changes++;
      applying.resolve();
      await applied.promise;
    },
  });
  const checks = Promise.all([active.checkNow(), active.checkNow(), active.checkNow()]);
  checks.then(() => { finished = true; });
  await tick();
  assert.equal(lookups, 1);
  lookupResult.resolve(secondGeo);
  await applying.promise;
  await tick();
  assert.equal(changes, 1);
  assert.equal(finished, false, 'check completes only after regional overrides are installed');
  applied.resolve();
  await checks;
  assert.equal(finished, true);
});

test('an unchanged IP does not reinstall fingerprints when geography metadata changes', async t => {
  let changes = 0;
  const active = monitor(t, {
    lookup: async () => ({ ...firstGeo, city: 'Updated city', isProxy: true }),
    onChange: async () => { changes++; },
  });
  await active.checkNow();
  assert.equal(changes, 0);
});

test('the same IP reapplies its configuration after the effective system egress key changes', async t => {
  const first = { ...firstGeo, egressKey: 'system:direct' };
  const throughProxy = { ...firstGeo, egressKey: 'system:http://127.0.0.1:7890' };
  const responses = [throughProxy, { ...throughProxy, city: 'Metadata refresh' }];
  const changes = [];
  const active = monitor(t, {
    initialGeo: first,
    lookup: async () => responses.shift(),
    onChange: async (next, previous) => { changes.push([next.egressKey, previous.egressKey]); },
  });
  await active.checkNow();
  await active.checkNow();
  assert.deepEqual(changes, [[throughProxy.egressKey, first.egressKey]],
    'a route change must refresh protection once without regenerating the same-IP identity');
});

test('same-IP observation warnings refresh without reinstalling the fingerprint and callbacks remain serialized', async t => {
  const initial = { ...firstGeo, egressKey: 'same-route',
    egressObservations: [{ source: 'primary', ip: firstGeo.ip }, { source: 'secondary', ip: firstGeo.ip }],
    egressWarning: null };
  const warningAdded = { ...initial,
    egressObservations: [{ source: 'primary', ip: firstGeo.ip }, { source: 'secondary', ip: secondGeo.ip }],
    egressWarning: 'multiple public exits observed' };
  const warningRemoved = { ...initial };
  const responses = [warningAdded, warningRemoved, new Error('observation lookup unavailable')];
  const callbackFinished = deferred();
  const observations = [];
  let lookups = 0;
  let changes = 0;
  const active = monitor(t, {
    initialGeo: initial,
    lookup: async () => {
      lookups++;
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    onChange: async () => { changes++; },
    onObservation: async next => {
      observations.push({ warning: next.egressWarning, ips: next.egressObservations.map(row => row.ip) });
      if (observations.length === 1) await callbackFinished.promise;
    },
    log: () => {},
  });
  const first = active.checkNow();
  let shared;
  try {
    await tick();
    assert.equal(observations.length, 1, 'a newly observed split route must be delivered despite unchanged primary IP');
    shared = active.checkNow();
    await tick();
    assert.equal(lookups, 1, 'a pending observation callback serializes subsequent checks');
  } finally { callbackFinished.resolve(); }
  await Promise.all([first, shared]);
  await active.checkNow();
  await active.checkNow();
  assert.deepEqual(observations, [
    { warning: warningAdded.egressWarning, ips: [firstGeo.ip, secondGeo.ip] },
    { warning: null, ips: [firstGeo.ip, firstGeo.ip] },
  ], 'warnings are added and removed only for successful valid observations');
  assert.equal(changes, 0, 'observation-only changes preserve the installed fingerprint');
  assert.equal(lookups, 3);
});

test('equivalent IPv6 addresses are compared canonically and a changed address is applied', async t => {
  const responses = [
    { ...firstGeo, ip: '2001:0DB8:0000:0000:0000:0000:0000:0001' },
    { ...secondGeo, ip: '2001:db8::2' },
  ];
  const changes = [];
  const active = monitor(t, {
    initialGeo: { ...firstGeo, ip: '2001:db8::1' },
    lookup: async () => responses.shift(),
    onChange: async geo => { changes.push(geo.ip); },
  });
  await active.checkNow();
  await active.checkNow();
  assert.deepEqual(changes, ['2001:db8::2']);
});

test('a failed lookup keeps the last successful fingerprint and retries later', async t => {
  let attempts = 0;
  const changes = [];
  const messages = [];
  const active = monitor(t, {
    lookup: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary network failure');
      return secondGeo;
    },
    onChange: async geo => { changes.push(geo); },
    log: message => messages.push(message),
  });
  await active.checkNow();
  assert.deepEqual(changes, []);
  assert.ok(messages.length > 0, 'an unsuccessful lookup is visible in diagnostics');
  await active.checkNow();
  await active.checkNow();
  assert.equal(attempts, 3);
  assert.deepEqual(changes, [secondGeo], 'successful application becomes the new IP baseline');
});

test('a failed fingerprint update does not commit the new IP and is retried', async t => {
  let attempts = 0;
  const active = monitor(t, {
    lookup: async () => secondGeo,
    onChange: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary target override failure');
    },
    log: () => {},
  });
  await active.checkNow();
  await active.checkNow();
  await active.checkNow();
  assert.equal(attempts, 2, 'the monitor advances only after onChange succeeds');
});

test('a partial fingerprint update is repaired when the next observed IP returns to the previous IP', async t => {
  const responses = [secondGeo, firstGeo, firstGeo];
  const changes = [];
  let appliedIp = firstGeo.ip;
  const active = monitor(t, {
    lookup: async () => responses.shift(),
    onChange: async next => {
      changes.push(next.ip);
      // The real driver commits its desired config before applying each target;
      // an error may leave some existing pages and new tabs on the next config.
      appliedIp = next.ip;
      if (changes.length === 1) throw new Error('one target failed after other targets updated');
    },
    log: () => {},
  });
  await active.checkNow();
  assert.equal(appliedIp, secondGeo.ip, 'simulate the partial application before its failure');
  await active.checkNow();
  assert.equal(appliedIp, firstGeo.ip,
    'returning to the previous IP must repair pages changed by the unsuccessful update');
  await active.checkNow();
  assert.deepEqual(changes, [secondGeo.ip, firstGeo.ip], 'once repaired, the same IP needs no further installation');
});

test('incomplete current-IP data is ignored without replacing valid startup geography', async t => {
  const responses = [{ ...secondGeo, ip: 'not-an-ip' }, { ...secondGeo, timezone: '' }, secondGeo];
  const changes = [];
  const active = monitor(t, {
    lookup: async () => responses.shift(),
    onChange: async geo => { changes.push(geo); },
    log: () => {},
  });
  await active.checkNow();
  await active.checkNow();
  assert.deepEqual(changes, []);
  await active.checkNow();
  assert.deepEqual(changes, [secondGeo]);
});

test('scheduled checks continue after failure and stop once the session ends', { timeout: 3000 }, async t => {
  const changed = deferred();
  let lookups = 0;
  const active = monitor(t, {
    intervalMs: 10,
    lookup: async () => {
      lookups++;
      if (lookups === 1) throw new Error('transient failure');
      return secondGeo;
    },
    onChange: async () => { changed.resolve(); },
    log: () => {},
  });
  await changed.promise;
  await active.stop();
  const stoppedAt = lookups;
  await active.checkNow();
  assert.equal(lookups, stoppedAt, 'an explicit check cannot restart a stopped monitor');
  assert.ok(stoppedAt >= 2);
});

test('stop aborts the active lookup and ignores a late result', async t => {
  const entered = deferred();
  const lookupResult = deferred();
  let querySignal;
  let changes = 0;
  let stopped = false;
  const active = monitor(t, {
    lookup: async ({ signal }) => {
      querySignal = signal;
      entered.resolve();
      return lookupResult.promise;
    },
    onChange: async () => { changes++; },
  });
  const check = active.checkNow();
  await entered.promise;
  const stopping = active.stop().then(() => { stopped = true; });
  assert.equal(querySignal.aborted, true);
  await tick();
  assert.equal(stopped, false, 'stop waits for the in-flight lookup to settle');
  lookupResult.resolve(secondGeo);
  await Promise.all([check, stopping]);
  assert.equal(changes, 0, 'a result arriving after stop cannot change the live session');
});

test('session cancellation aborts monitoring and never applies the cancelled query', async t => {
  const entered = deferred();
  const controller = new AbortController();
  let querySignal;
  let changes = 0;
  const active = monitor(t, {
    signal: controller.signal,
    lookup: ({ signal }) => {
      querySignal = signal;
      entered.resolve();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    onChange: async () => { changes++; },
    log: () => {},
  });
  const check = active.checkNow();
  await entered.promise;
  controller.abort(new Error('browser closed'));
  await check;
  await active.stop();
  assert.equal(querySignal.aborted, true);
  assert.equal(changes, 0);
});

test('an already cancelled session does not start another IP lookup', async t => {
  const controller = new AbortController();
  controller.abort(new Error('session ended before monitoring'));
  let lookups = 0;
  const active = monitor(t, {
    signal: controller.signal,
    lookup: async () => { lookups++; return secondGeo; },
    onChange: async () => assert.fail('a cancelled session cannot apply fingerprints'),
  });
  await active.checkNow();
  await active.stop();
  assert.equal(lookups, 0);
});
