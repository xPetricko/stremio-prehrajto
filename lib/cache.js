const store = new Map();
function get(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) { store.delete(key); return undefined; }
  return e.val;
}
function set(key, val, ttlMs) {
  store.set(key, { val, exp: Date.now() + ttlMs });
  if (store.size > 2000) store.delete(store.keys().next().value);
  return val;
}
async function wrap(key, ttlMs, fn) {
  const hit = get(key);
  if (hit !== undefined) return hit;
  return set(key, await fn(), ttlMs);
}
module.exports = { get, set, wrap };
