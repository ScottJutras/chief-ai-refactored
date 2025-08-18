// services/firebase.js
// Dependency-free, production-safe Firebase shim.
// It satisfies legacy imports without doing any network I/O or writes.
// Remove callers gradually; meanwhile nothing here will consume API keys
// or cause DB spam.

const DEV = process.env.NODE_ENV === 'development';

function dlog(...args) {
  if (DEV) {
    // keep quiet by default to avoid noisy logs
    // console.debug('[firebase-shim]', ...args);
  }
}

// Generic no-op function and async variants
const noop = () => undefined;
const noopAsync = async () => undefined;

// Return an object whose methods are all no-ops
function makeNoopTree() {
  const handler = {
    get(_target, prop) {
      // return a function that can be awaited or called
      const fn = (..._args) => {
        dlog(`call: ${String(prop)}`);
        return undefined;
      };
      // also support thenable pattern accidentally
      fn.then = undefined;
      return new Proxy(fn, handler);
    },
    apply(_target, _thisArg, _args) {
      return undefined;
    }
  };
  return new Proxy(noop, handler);
}

// Common shapes callers might expect:
const auth = {
  verifyIdToken: async (_token) => {
    dlog('auth.verifyIdToken');
    return null; // pretend unauthenticated
  },
  getUser: async (_uid) => null,
  createUser: async (_opts) => ({ uid: 'noop' }),
};

const dbDoc = () => ({
  set: noopAsync,
  get: async () => ({ exists: false, data: () => null }),
  update: noopAsync,
  delete: noopAsync,
});

const dbCollection = () => ({
  doc: dbDoc,
  add: noopAsync,
  where: () => ({ get: async () => ({ empty: true, docs: [] }) }),
  get: async () => ({ empty: true, docs: [] }),
});

const db = {
  collection: dbCollection,
  doc: dbDoc,
  runTransaction: async (fn) => fn({ get: dbDoc().get, set: noop, update: noop, delete: noop }),
};

const storage = {
  upload: noopAsync,
  getUrl: async () => null,
  delete: noopAsync,
};

// Some codebases import default and/or named exports.
// Provide both to be extra compatible.
const firebaseShim = {
  init: noopAsync,
  auth,
  db,
  storage,
  // catch-alls for any unexpected calls
  app: makeNoopTree(),
  admin: makeNoopTree(),
  analytics: makeNoopTree(),
  messaging: makeNoopTree(),
  functions: makeNoopTree(),
  // generic logger
  log: (...args) => dlog(...args),
};

module.exports = firebaseShim;
module.exports.default = firebaseShim;
module.exports.auth = auth;
module.exports.db = db;
module.exports.storage = storage;
module.exports.init = firebaseShim.init;
module.exports.log = firebaseShim.log;
