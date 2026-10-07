import { canonicalIPAddress } from './fingerprint.mjs';
import { isUsableGeo } from './geo.mjs';

/** Serialize IP checks; failed lookups or applications keep the last valid state. */
export function startIPMonitor({ lookup, onChange, onObservation, initialGeo, intervalMs = 30000, signal, log = () => {} }) {
  if (typeof lookup !== 'function' || typeof onChange !== 'function' || !isUsableGeo(initialGeo) ||
      !Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('IP 自动检测配置无效');
  let currentGeo = initialGeo;
  let pending;
  let timer;
  let stopped = false;
  let needsApply = false;
  const controller = new AbortController();
  const schedule = () => {
    if (!stopped) {
      timer = setTimeout(() => { checkNow(); }, intervalMs);
      timer.unref?.();
    }
  };
  function checkNow() {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    pending = Promise.resolve().then(async () => {
      if (stopped) return;
      const next = await lookup({ signal: controller.signal });
      if (stopped) return;
      if (!isUsableGeo(next)) throw new Error('接口未返回有效的当前 IP 和归属地');
      if (!needsApply && canonicalIPAddress(next.ip) === canonicalIPAddress(currentGeo.ip) &&
          next.egressKey === currentGeo.egressKey) {
        // Secondary endpoints may reveal split routing without changing the
        // selected fingerprint IP. Refresh observations without reinstalling it.
        await onObservation?.(next, currentGeo);
        return;
      }
      // A failed update may have reached some targets. Even if the next lookup
      // returns the old IP, reapply it to repair those partially updated targets.
      needsApply = true;
      await onChange(next, currentGeo);
      if (!stopped) { currentGeo = next; needsApply = false; }
    }).catch(error => {
      if (!stopped) log('[警告] IP 自动检测或指纹更新失败，稍后重新检测并应用当前 IP: ' + error.message);
    }).finally(() => {
      pending = undefined;
      schedule();
    });
    return pending;
  }
  async function stop() {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort(new Error('IP 自动检测已停止'));
    await pending;
  }
  const abort = () => { void stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort(); else schedule();
  return { checkNow, stop };
}
