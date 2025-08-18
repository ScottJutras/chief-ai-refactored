// handlers/commands/metrics.js
// Lightweight, dependency-free metrics shim to avoid crashes if a real metrics backend isn't wired up yet.
// Safe for prod: does nothing except (optionally) debug-log in development.

const DEV = process.env.NODE_ENV === 'development';

// Basic no-op logger
function log(fn, name, value, tags) {
  if (!DEV) return;
  try {
    // keep logs small to avoid spam
    // console.debug(`[metrics:${fn}]`, name, value ?? '', tags ? JSON.stringify(tags) : '');
  } catch (_) { /* ignore */ }
}

const metrics = {
  // Common patterns different files might expect
  event(name, tags = {}, value = 1)     { log('event', name, value, tags); },
  trackEvent(name, tags = {}, value = 1){ log('trackEvent', name, value, tags); },
  increment(name, value = 1, tags = {}) { log('increment', name, value, tags); },
  count(name, value = 1, tags = {})     { log('count', name, value, tags); },
  gauge(name, value = 0, tags = {})     { log('gauge', name, value, tags); },
  timing(name, ms = 0, tags = {})       { log('timing', name, ms, tags); },
  observe(name, value = 0, tags = {})   { log('observe', name, value, tags); },
  histogram(name, value = 0, tags = {}) { log('histogram', name, value, tags); },
  // Error path
  error(name, err, tags = {})           { log('error', name, err?.message || err, tags); },
};

// Also be resilient if code calls any other method name:
module.exports = new Proxy(metrics, {
  get(target, prop) {
    if (prop in target) return target[prop];
    // return no-op function for unknown calls
    return (...args) => log(String(prop), args?.[0], args?.[1], args?.[2]);
  }
});
