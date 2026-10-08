const test = require('node:test');
const assert = require('node:assert/strict');
const { RevisionQueue, CloudClient, emptyData } = require('../cloud-sync.js');
const row = (id, name, version = 1, deleted = false) => ({ collection: 'schools', id, payload: { id, name }, version, deleted });
const change = (q, name) => { const data = q.materialize(); data.schools[0].name = name; q.observe(data); };

test('a local edit queues only the edited record; another member can edit a different one', () => {
  const q = new RevisionQueue(); q.loadRemote([row('s1', 'A'), row('s2', 'B')]);
  change(q, 'A edited');
  assert.equal(q.batch().length, 1); assert.equal(q.batch()[0].base_version, 1);
  assert.equal(q.conflicts([row('s1', 'A'), row('s2', 'B edited', 2)]).length, 0);
  q.loadRemote([row('s1', 'A'), row('s2', 'B edited', 2)]);
  assert.deepEqual(q.materialize().schools.map(s => s.name), ['A edited', 'B edited']);
});
test('editing again while save is in flight keeps the second edit with the acknowledged version', () => {
  const q = new RevisionQueue(); q.loadRemote([row('s1', 'A')]); change(q, 'first');
  const sent = q.batch(); change(q, 'second'); q.acknowledge(sent, [row('s1', 'first', 2)]);
  assert.equal(q.batch()[0].payload.name, 'second'); assert.equal(q.batch()[0].base_version, 2);
  q.acknowledge(q.batch(), [row('s1', 'second', 3)]); assert.equal(q.pending.size, 0);
});
test('reverting an in-flight change sends the revert after receipt', () => {
  const q = new RevisionQueue(); q.loadRemote([row('s1', 'A')]); change(q, 'B');
  const sent = q.batch(); change(q, 'A'); q.acknowledge(sent, [row('s1', 'B', 2)]);
  assert.equal(q.batch()[0].payload.name, 'A'); assert.equal(q.batch()[0].base_version, 2);
});
test('delete carries a valid tombstone and survives persisted-queue reload', () => {
  const q = new RevisionQueue(); q.loadRemote([row('s1', 'A')]); q.observe(emptyData());
  assert.deepEqual(q.batch()[0].payload, { id: 's1' }); assert.equal(q.batch()[0].deleted, true);
  const restored = new RevisionQueue(JSON.parse(JSON.stringify(q.serialize())));
  restored.loadRemote([row('s1', 'A')]); assert.equal(restored.materialize().schools.length, 0);
  assert.equal(restored.batch()[0].base_version, 1);
});
test('a timeout after commit is reconciled from the server, including tombstones', () => {
  const q = new RevisionQueue(); q.loadRemote([row('s1', 'A')]); change(q, 'B');
  q.reconcileAcknowledgement([row('s1', 'B', 2)]); assert.equal(q.pending.size, 0);
  q.loadRemote([row('s1', 'B', 2)]); q.observe(emptyData());
  q.reconcileAcknowledgement([row('s1', '', 3, true)]); assert.equal(q.pending.size, 0);
});
test('another user changing the same record raises a conflict without losing the local edit', () => {
  const q = new RevisionQueue(); q.loadRemote([row('s1', 'A')]); change(q, 'my edit');
  const remote = [row('s1', 'their edit', 2)]; assert.equal(q.conflicts(remote).length, 1);
  q.loadRemote(remote); assert.equal(q.materialize().schools[0].name, 'my edit');
  assert.equal(q.batch()[0].base_version, 1);
});
test('same content with differing object property order does not create a false edit', () => {
  const q = new RevisionQueue(); q.loadRemote([row('s1', 'A')]);
  q.observe({ ...emptyData(), schools: [{ name: 'A', id: 's1' }] }); assert.equal(q.pending.size, 0);
});

function mockStorage() { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k) }; }
function fixture() {
  global.localStorage = mockStorage(); global.sessionStorage = mockStorage(); global.document = { getElementById: () => null };
  Object.defineProperty(global, 'navigator', { value: { onLine: true }, configurable: true });
  const app = { data: { ...emptyData(), schools: [{ id: 's1', name: 'A' }] }, refreshPage() {}, updateStorageInfo() {} };
  const c = new CloudClient({ url: 'https://example.supabase.co', workspaceId: 'test', publishableKey: 'public' }, app, { set() {} });
  c.session = { user: { id: 'member-1' } }; c.ready = true; c.queue.loadRemote([row('s1', 'A')]); change(c.queue, 'B');
  return c;
}
test('save success clears the queue only after the database acknowledges it', async () => {
  const c = fixture(); let calls = 0;
  c.request = async (path, options) => { calls++; const payload = JSON.parse(options.body); assert.equal(path, 'rpc/apply_school_map_changes'); assert.equal(payload.p_changes[0].base_version, 1); assert.equal(c.queue.pending.size, 1); return { records: [row('s1', 'B', 2)] }; };
  await c.flush(); assert.equal(calls, 1); assert.equal(c.queue.pending.size, 0); assert.match(c.message, /已保存到云端/);
});
test('offline does not submit, then reconnect submits the persisted edit', async () => {
  const c = fixture(); let calls = 0; navigator.onLine = false;
  c.request = async () => { calls++; return { records: [row('s1', 'B', 2)] }; };
  c.persist(); await c.flush(); assert.equal(calls, 0); assert.equal(c.queue.pending.size, 1);
  navigator.onLine = true; await c.flush(); assert.equal(calls, 1); assert.equal(c.queue.pending.size, 0);
});
test('server conflict pauses retries and retains the edit and durable outbox', async () => {
  const c = fixture(); let calls = 0;
  c.request = async () => { calls++; const error = new Error('conflict'); error.code = '40001'; throw error; };
  c.persist(); await c.flush(); await c.flush(); assert.equal(calls, 1); assert.equal(c.conflicted, true); assert.equal(c.queue.batch()[0].payload.name, 'B');
  assert.equal(JSON.parse(localStorage.getItem(c.queueKey)).pending.length, 1);
});
test('network error retains queue and never reports a cloud save success', async () => {
  const c = fixture(); c.request = async () => { throw new Error('offline'); }; await c.flush();
  assert.equal(c.queue.pending.size, 1); assert.match(c.message, /失败/); assert.equal(c.busy, false);
});
test('a form opened during polling keeps its old version for conflict detection', async () => {
  const c = fixture(); c.queue = new RevisionQueue(); c.queue.loadRemote([row('s1', 'A')]);
  let modalOpen = false; document.getElementById = id => id === 'modalOverlay' ? { classList: { contains: () => !modalOpen } } : null;
  c.readRows = async () => { modalOpen = true; return [row('s1', 'other user', 2)]; };
  await c.tick(); assert.equal(c.queue.base.values().next().value.version, 1);
  change(c.queue, 'my old form'); assert.equal(c.queue.batch()[0].base_version, 1);
});
test('temporary refresh failure preserves session and editing readiness for automatic retry', async () => {
  const c = fixture(); c.session.refresh_token = 'refresh';
  c.auth = async () => { const error = new Error('server unavailable'); error.status = 503; throw error; };
  await assert.rejects(c.ensureSession()); assert.equal(c.ready, true); assert.equal(c.session.user.id, 'member-1');
});
test('confirmed expired refresh token requires login while keeping local queue', async () => {
  const c = fixture(); c.auth = async () => { const error = new Error('invalid refresh'); error.status = 400; throw error; };
  await assert.rejects(c.ensureSession()); assert.equal(c.ready, false); assert.equal(c.session, null); assert.equal(c.queue.pending.size, 1);
});
test('logout cannot race an in-flight pull and restore data after exit', async () => {
  const c = fixture(); c.busy = true; await c.logout(); assert.notEqual(c.session, null); assert.match(c.message, /稍后/);
});
test('revoked membership pauses cloud editing instead of interpreting denial as an empty map', async () => {
  const c = fixture(); c.queue = new RevisionQueue(); c.queue.loadRemote([row('s1', 'A')]);
  c.readRows = async () => { const error = new Error('membership revoked'); error.code = '42501'; throw error; };
  await c.tick(); assert.equal(c.ready, false); assert.equal(c.queue.materialize().schools[0].name, 'A'); assert.match(c.message, /权限已被撤销/);
});
test('login cannot switch accounts while an automatic connection is restoring a pending queue', async () => {
  const c = fixture(); c.connecting = true; let authenticated = false;
  c.auth = async () => { authenticated = true; };
  await c.login('another@example.com', 'unused');
  assert.equal(authenticated, false); assert.equal(c.session.user.id, 'member-1'); assert.equal(c.queue.batch()[0].payload.name, 'B');
});
test('a different account cannot adopt another member\'s durable pending changes', async () => {
  const c = fixture(); c.persist(); c.session.user.id = 'member-2';
  c.request = async () => [{ user_id: 'member-2' }];
  await assert.rejects(c.connect(), /其他账号/); assert.equal(c.ready, false); assert.equal(c.connecting, false);
  assert.equal(JSON.parse(localStorage.getItem(c.queueKey)).userId, 'member-1');
});
