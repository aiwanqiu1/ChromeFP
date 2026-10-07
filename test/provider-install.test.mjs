import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildProvider } from '../lib/provider.mjs';

function pageRealm() {
  const context = vm.createContext({});
  vm.runInContext(`
    globalThis.Navigator = class Navigator {};
    globalThis.navigator = new Navigator();
    globalThis.HTMLCanvasElement = class Canvas {
      constructor() { this.width = 8; this.height = 8; this.pixels = new Uint8ClampedArray(256).fill(100); }
      getContext() { return new CanvasRenderingContext2D(this); }
      toDataURL() { return Array.from(this.pixels).join(','); }
    };
    globalThis.CanvasRenderingContext2D = class Context {
      constructor(canvas) { this.canvas = canvas; }
      getImageData() { return { width: 8, height: 8, data: this.canvas.pixels.slice() }; }
      putImageData(image) { this.canvas.pixels.set(image.data); }
    };
    globalThis.document = { createElement: () => new HTMLCanvasElement() };
    globalThis.location = { protocol: 'https:' };
  `, context);
  return context;
}

const keys = context => Array.from(vm.runInContext('Reflect.ownKeys(globalThis)', context));

test('provider installation adds no global marker or symbol', () => {
  const context = pageRealm();
  const before = keys(context);
  vm.runInContext(buildProvider({ hardwareConcurrency: 8 }), context);
  assert.deepEqual(keys(context), before);
  assert.equal(vm.runInContext('globalThis[Symbol.for("ChromeFP.provider.installed")]', context), undefined);
});

test('repeating one provider payload preserves wrapper identities and applies Canvas noise once', () => {
  const context = pageRealm();
  const source = buildProvider({ hardwareConcurrency: 8, canvasNoise: true, noiseSeed: 12345 });
  vm.runInContext(source, context);
  const firstToString = vm.runInContext('Function.prototype.toString', context);
  const firstRead = vm.runInContext('CanvasRenderingContext2D.prototype.getImageData', context);
  const firstExport = vm.runInContext('HTMLCanvasElement.prototype.toDataURL', context);
  const firstGetter = vm.runInContext('Object.getOwnPropertyDescriptor(Navigator.prototype,"hardwareConcurrency").get', context);
  const read = () => vm.runInContext(`JSON.stringify(Array.from(new HTMLCanvasElement().getContext('2d').getImageData().data))`, context);
  const first = read();
  vm.runInContext(source, context);
  assert.equal(vm.runInContext('Function.prototype.toString', context), firstToString);
  assert.equal(vm.runInContext('CanvasRenderingContext2D.prototype.getImageData', context), firstRead);
  assert.equal(vm.runInContext('HTMLCanvasElement.prototype.toDataURL', context), firstExport);
  assert.equal(vm.runInContext('Object.getOwnPropertyDescriptor(Navigator.prototype,"hardwareConcurrency").get', context), firstGetter);
  assert.equal(read(), first);
  const pixels = JSON.parse(first);
  assert.ok(pixels.some((value, index) => index % 4 === 0 && value !== 100), 'the noise must actually run');
  assert.ok(pixels.every(value => Math.abs(value - 100) <= 1), 'one installation must not accumulate noise');
});

test('toString preserves normal reads, ignores ordinary extra arguments and rejects invalid receivers', () => {
  const context = pageRealm();
  vm.runInContext('globalThis.ordinary = function ordinary(value) { return value + 1; }', context);
  const before = vm.runInContext('Function.prototype.toString.call(ordinary)', context);
  vm.runInContext(buildProvider({ hardwareConcurrency: 8 }), context);
  assert.equal(vm.runInContext('Function.prototype.toString.call(ordinary)', context), before);
  assert.equal(vm.runInContext('Function.prototype.toString.call(ordinary,"unrelated extra argument")', context), before);
  assert.equal(vm.runInContext('Function.prototype.toString.call(Function.prototype.toString,"unrelated extra argument")', context),
    'function toString() { [native code] }');
  assert.throws(() => vm.runInContext('Function.prototype.toString.call({})', context), error => error.name === 'TypeError');
  assert.throws(() => vm.runInContext('Function.prototype.toString.call(null)', context), error => error.name === 'TypeError');
});

test('the same payload installs independently in a new document realm', () => {
  const first = pageRealm();
  const second = pageRealm();
  const source = buildProvider({ hardwareConcurrency: 8, deviceMemory: 8 });
  const originalFirst = vm.runInContext('Function.prototype.toString', first);
  const originalSecond = vm.runInContext('Function.prototype.toString', second);
  for (const context of [first, second]) {
    vm.runInContext(source, context);
    vm.runInContext(source, context);
    assert.equal(vm.runInContext('navigator.hardwareConcurrency', context), 8);
    assert.equal(vm.runInContext('navigator.deviceMemory', context), 8);
  }
  assert.notEqual(vm.runInContext('Function.prototype.toString', first), originalFirst);
  assert.notEqual(vm.runInContext('Function.prototype.toString', second), originalSecond);
});

test('internal documents stay native while Worker installation never reads location', () => {
  const context = pageRealm();
  const original = vm.runInContext('Function.prototype.toString', context);
  vm.runInContext('location.protocol="chrome:"', context);
  const source = buildProvider({ hardwareConcurrency: 8 });
  vm.runInContext(source, context);
  assert.equal(vm.runInContext('Function.prototype.toString', context), original);
  assert.equal(vm.runInContext('navigator.hardwareConcurrency', context), undefined);
  vm.runInContext('location.protocol="https:"', context);
  vm.runInContext(source, context);
  assert.equal(vm.runInContext('navigator.hardwareConcurrency', context), 8);

  const worker = vm.createContext({});
  vm.runInContext(`
    globalThis.WorkerNavigator = class WorkerNavigator {};
    globalThis.navigator = new WorkerNavigator();
    Object.defineProperty(globalThis, 'location', { get() { throw new Error('WorkerLocation must not be read while paused'); } });
  `, worker);
  vm.runInContext(source, worker);
  vm.runInContext(source, worker);
  assert.equal(vm.runInContext('navigator.hardwareConcurrency', worker), 8);
});
