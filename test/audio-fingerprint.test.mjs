import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { buildProvider } from '../lib/provider.mjs';

function audioRealm() {
  const context = vm.createContext({});
  vm.runInContext(`
    class AudioBuffer {
      constructor() { this.length = 128; this.channels = [new Float32Array(128).fill(.25), new Float32Array(128).fill(.5)]; }
      getChannelData(channel) {
        if (!(this instanceof AudioBuffer)) throw new TypeError('invalid receiver');
        if (!arguments.length) throw new TypeError('missing channel');
        channel = channel >>> 0;
        if (channel >= this.channels.length) throw new RangeError('invalid channel');
        return this.channels[channel];
      }
      copyFromChannel(destination, channel, offset = 0) {
        if (!(this instanceof AudioBuffer) || !(destination instanceof Float32Array)) throw new TypeError('invalid arguments');
        channel = channel >>> 0; offset = offset >>> 0;
        if (channel >= this.channels.length) throw new RangeError('invalid channel');
        destination.set(this.channels[channel].subarray(offset, offset + destination.length));
      }
    }
    globalThis.AudioBuffer = AudioBuffer;
    globalThis.buffer = new AudioBuffer();
  `, context);
  return context;
}
const samples = context => JSON.parse(vm.runInContext('JSON.stringify(Array.from(buffer.getChannelData(0)))', context));

test('AudioBuffer fingerprint changes with its IP seed, preserves the native shared array and restores disabled noise', () => {
  const context = audioRealm();
  vm.runInContext(buildProvider({ audioNoise: true, noiseSeed: 12345 }, 'audio-update-key'), context);
  const first = samples(context);
  assert.ok(first.some(value => value !== .25), 'OfflineAudio rendering must receive actual seed noise');
  assert.deepEqual(samples(context), first);
  assert.equal(vm.runInContext('buffer.getChannelData(0) === buffer.channels[0]', context), true);
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(Array.from(buffer.channels[0]))', context)), first);
  const wrapper = vm.runInContext('AudioBuffer.prototype.getChannelData', context);
  vm.runInContext(buildProvider({ audioNoise: true, noiseSeed: 54321 }, 'audio-update-key'), context);
  assert.equal(vm.runInContext('AudioBuffer.prototype.getChannelData', context), wrapper);
  assert.notDeepEqual(samples(context), first);
  assert.deepEqual(samples(context), samples(context));
  vm.runInContext(buildProvider({ audioNoise: false, hardwareConcurrency: 8, noiseSeed: 54321 }, 'audio-update-key'), context);
  assert.ok(samples(context).every(value => value === .25));
});

test('copyFromChannel agrees with getChannelData offsets and leaves unfilled destination tails alone', () => {
  const context = audioRealm();
  vm.runInContext(buildProvider({ audioNoise: true, noiseSeed: 12345 }), context);
  const first = samples(context);
  const copied = JSON.parse(vm.runInContext(`const destination = new Float32Array(150).fill(37);
    buffer.copyFromChannel(destination, 0, 120); JSON.stringify(Array.from(destination))`, context));
  assert.deepEqual(copied.slice(0, 8), first.slice(120));
  assert.ok(copied.slice(8).every(value => value === 37));
  assert.equal(vm.runInContext('buffer.getChannelData(0) === buffer.channels[0]', context), true);
  vm.runInContext('destination.fill(37);buffer.copyFromChannel(destination,0,999)', context);
  assert.equal(vm.runInContext('destination.every(value => value === 37)', context), true);
});

test('AudioBuffer patches preserve native validation, caller writes, array identity and stable noise', () => {
  const context = audioRealm();
  vm.runInContext(buildProvider({ audioNoise: true, noiseSeed: 12345 }), context);
  vm.runInContext('globalThis.shared = buffer.getChannelData(0);shared.fill(.75)', context);
  assert.equal(vm.runInContext('buffer.channels[0].every(value => value === .75)', context), true);
  const written = samples(context);
  assert.ok(written.every(value => Math.abs(value - .75) < 1e-6));
  assert.deepEqual(samples(context), written);
  assert.equal(vm.runInContext('shared === buffer.getChannelData(0)', context), true);
  const copied = JSON.parse(vm.runInContext('const copy=new Float32Array(128);buffer.copyFromChannel(copy,0);JSON.stringify(Array.from(copy))', context));
  assert.deepEqual(copied, written);
  for (const expression of ['buffer.getChannelData()', 'buffer.getChannelData(99)',
    'AudioBuffer.prototype.getChannelData.call({},0)', 'buffer.copyFromChannel([],0)',
    'buffer.copyFromChannel(new Float32Array(8),99)']) {
    assert.throws(() => vm.runInContext(expression, context), undefined, expression);
  }
});
