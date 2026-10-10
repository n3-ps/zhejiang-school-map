const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RevisionQueue, CloudClient, emptyData, boot, COLLECTIONS } = require('../cloud-sync.js');
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

for (const collection of ['channels', 'servicePoints']) {
  test(`${collection} create, edit and delete use acknowledged versions and durable tombstones`, () => {
    const entity = (name, version, deleted = false) => ({ collection, id: 'partner-1', payload: deleted ? { id: 'partner-1' } : { id: 'partner-1', name }, version, deleted });
    const q = new RevisionQueue(); q.loadRemote([row('s1', 'Existing school')]);
    const data = q.materialize(); data[collection] = [{ id: 'partner-1', name: 'Created' }]; q.observe(data);
    assert.equal(q.batch().length, 1);
    assert.deepEqual(q.batch()[0], { collection, id: 'partner-1', payload: { id: 'partner-1', name: 'Created' }, deleted: false, base_version: 0 });
    q.acknowledge(q.batch(), [entity('Created', 1)]);
    assert.equal(q.pending.size, 0);

    const edit = q.materialize(); edit[collection][0].name = 'Edited'; q.observe(edit);
    assert.equal(q.batch()[0].base_version, 1);
    q.acknowledge(q.batch(), [entity('Edited', 2)]);
    assert.equal(q.materialize()[collection][0].name, 'Edited');
    const remove = q.materialize(); remove[collection] = []; q.observe(remove);
    assert.deepEqual(q.batch()[0], { collection, id: 'partner-1', payload: { id: 'partner-1' }, deleted: true, base_version: 2 });

    const restored = new RevisionQueue(JSON.parse(JSON.stringify(q.serialize())));
    restored.loadRemote([row('s1', 'Existing school'), entity('Edited', 2)]);
    assert.equal(restored.materialize()[collection].length, 0);
    assert.equal(restored.batch()[0].base_version, 2);
    restored.acknowledge(restored.batch(), [entity('', 3, true)]);
    assert.equal(restored.pending.size, 0);
    restored.loadRemote([row('s1', 'Existing school'), entity('', 3, true)]);
    assert.equal(restored.materialize()[collection].length, 0);
    assert.equal(restored.materialize().schools[0].name, 'Existing school');
  });

  test(`${collection} a pending edit survives reload and a newer remote record without losing conflict detection`, () => {
    const q = new RevisionQueue();
    const remote = { collection, id: 'partner-1', payload: { id: 'partner-1', name: 'Original' }, version: 4, deleted: false };
    q.loadRemote([remote]);
    const edit = q.materialize(); edit[collection][0].name = 'Local edit'; q.observe(edit);
    const restored = new RevisionQueue(JSON.parse(JSON.stringify(q.serialize())));
    const updated = { ...remote, payload: { ...remote.payload, name: 'Other member' }, version: 5 };
    assert.equal(restored.conflicts([updated]).length, 1);
    restored.loadRemote([updated]);
    assert.equal(restored.materialize()[collection][0].name, 'Local edit');
    assert.equal(restored.batch()[0].base_version, 4);
  });
}

test('new partner records survive durable reload against a legacy five-collection cloud snapshot', () => {
  const q = new RevisionQueue(); q.loadRemote([row('s1', 'Existing school')]);
  const data = q.materialize();
  data.channels = [{ id: 'shared-id', name: 'Channel' }];
  data.servicePoints = [{ id: 'shared-id', name: 'Service point', channelId: 'shared-id' }];
  q.observe(data);
  const restored = new RevisionQueue(JSON.parse(JSON.stringify(q.serialize())));
  const legacySnapshot = [row('s1', 'Another member edited the school', 2)];
  restored.loadRemote(legacySnapshot);
  assert.equal(restored.materialize().schools[0].name, 'Another member edited the school');
  assert.deepEqual(restored.materialize().channels, data.channels);
  assert.deepEqual(restored.materialize().servicePoints, data.servicePoints);
  assert.deepEqual(restored.batch().map(change => [change.collection, change.base_version]), [['channels', 0], ['servicePoints', 0]]);
  assert.equal(restored.conflicts(legacySnapshot).length, 0);
  restored.reconcileAcknowledgement(legacySnapshot);
  assert.equal(restored.pending.size, 2);
});

test('schema and online upgrade allow every synchronized collection and share the full version-checked RPC', () => {
  const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
  const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261010_partner_management.sql'), 'utf8');
  const expected = ['schools', 'deliveries', 'opportunities', 'persons', 'stakeholders', 'channels', 'servicePoints'];
  const quoted = text => [...text.matchAll(/'([^']+)'/g)].map(match => match[1]);
  const rpc = text => text.match(/create or replace function public\.apply_school_map_changes\([\s\S]*?\n\$\$;/i)?.[0].replace(/\r\n/g, '\n');
  assert.deepEqual(COLLECTIONS, expected);
  for (const sql of [schema, migration]) {
    const constraint = sql.match(/add constraint school_map_records_collection_check check \(collection in \(([\s\S]*?)\)\);/i);
    const whitelist = rpc(sql)?.match(/\(v_change ->> 'collection'\) not in \(([\s\S]*?)\)/);
    assert.ok(constraint); assert.ok(whitelist);
    assert.deepEqual(quoted(constraint[1]), expected);
    assert.deepEqual(quoted(whitelist[1]), expected);
  }
  assert.equal(rpc(migration), rpc(schema));
  assert.match(migration, /begin;[\s\S]*drop constraint if exists school_map_records_collection_check;[\s\S]*commit;\s*$/i);
  assert.doesNotMatch(migration, /\b(?:truncate|drop table|delete from public\.school_map_records)\b/i);
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
test('a legacy five-collection JSON backup is accepted and initializes empty partner arrays without uploading', async () => {
  const legacy = { schools: [{ id: 'legacy-school', name: 'Legacy school' }], deliveries: [], opportunities: [], persons: [], stakeholders: [], logs: [] };
  for (const backup of [legacy, { 'legacy-store': JSON.stringify(legacy) }]) {
    const c = fixture(); c.store.key = 'legacy-store'; c.queue = new RevisionQueue();
    let requested = false; c.request = async () => { requested = true; throw new Error('Choosing a backup must not upload it'); };
    await c.chooseMigrationBackup({ text: async () => JSON.stringify(backup) });
    assert.deepEqual(c.seed.schools, legacy.schools);
    assert.deepEqual(c.seed.channels, []);
    assert.deepEqual(c.seed.servicePoints, []);
    assert.deepEqual(JSON.parse(localStorage.getItem(c.recoveryKey)), c.seed);
    assert.equal(requested, false); assert.equal(c.queue.pending.size, 0);
    assert.match(c.message, /已选择迁移备份，尚未上传/);
  }
});

test('a backup with malformed partner collections is rejected without replacing the migration source', async () => {
  const c = fixture(); const original = JSON.parse(JSON.stringify(c.seed));
  for (const [collection, malformed] of [['channels', {}], ['channels', null], ['servicePoints', 'invalid'], ['servicePoints', 1]]) {
    const backup = { ...emptyData(), [collection]: malformed };
    await assert.rejects(c.chooseMigrationBackup({ text: async () => JSON.stringify(backup) }), /渠道或售后/);
    assert.deepEqual(c.seed, original);
    assert.equal(localStorage.getItem(c.recoveryKey), null);
    assert.equal(c.queue.batch()[0].payload.name, 'B');
  }
});

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

test('reloading with an existing session shows connection progress and restores the remote ledger without another login', async () => {
  const names = ['localStorage', 'sessionStorage', 'document', 'navigator', 'window', 'fetch', 'SCHOOL_MAP_CLOUD', 'schoolMapCloud'];
  const previous = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(global, name)]));
  let client;
  try {
    global.localStorage = mockStorage(); global.sessionStorage = mockStorage();
    global.SCHOOL_MAP_CLOUD = { url: 'https://example.supabase.co', workspaceId: 'test', publishableKey: 'public' };
    const session = { access_token: 'test-access', expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'member-1' } };
    const sessionKey = 'school-map-session:https://example.supabase.co:test';
    sessionStorage.setItem(sessionKey, JSON.stringify(session));
    const messages = [];
    const status = { set textContent(message) { messages.push(message); } };
    global.document = { visibilityState: 'visible', getElementById: id => id === 'cloudSaveStatus' ? status : null };
    global.window = { addEventListener() {} };
    Object.defineProperty(global, 'navigator', { configurable: true, value: { onLine: true, locks: { request: async (_name, _options, callback) => callback({}) } } });
    let finishSnapshot;
    const pendingSnapshot = new Promise(resolve => { finishSnapshot = resolve; });
    const requests = [];
    global.fetch = async url => {
      requests.push(url);
      if (url.includes('/rest/v1/school_map_members?')) return { ok: true, json: async () => [{ user_id: 'member-1' }] };
      if (url.endsWith('/rest/v1/rpc/read_school_map_snapshot')) return pendingSnapshot;
      throw new Error('Unexpected request during session restoration');
    };
    const store = { key: 'reload-ledger', set(data) { localStorage.setItem(this.key, JSON.stringify(data)); } };
    store.set({ ...emptyData(), schools: [{ id: 's1', name: 'cached version' }] });
    const app = {
      data: emptyData(),
      async init() { this.data = JSON.parse(localStorage.getItem(store.key)); },
      refreshPage() {}, updateStorageInfo() {}, toast() {}, closeModal() {}
    };
    for (const name of ['saveSchool', 'saveDelivery', 'saveOpportunity', 'saveStakeholder', 'savePerson', 'saveChannel', 'saveServicePoint', 'deleteSchool', 'deleteDelivery', 'deleteOpportunity', 'deleteStakeholder', 'deletePerson', 'deleteChannel', 'deleteServicePoint', 'importCSV']) app[name] = () => {};

    client = await boot(app, store);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.ready, false);
    assert.equal(client.session.user.id, 'member-1');
    assert.equal(messages.some(message => /请登录/.test(message)), false);
    assert.match(messages.at(-1), /连接|读取/);

    finishSnapshot({ ok: true, json: async () => ({ records: [row('s1', 'remote version', 2), row('s2', 'cloud addition')] }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.ready, true);
    assert.equal(client.session.access_token, session.access_token);
    assert.equal(JSON.parse(sessionStorage.getItem(sessionKey)).user.id, 'member-1');
    assert.deepEqual(app.data.schools.map(school => school.name), ['remote version', 'cloud addition']);
    assert.deepEqual(JSON.parse(localStorage.getItem(store.key)).schools, app.data.schools);
    assert.match(messages.at(-1), /已连接云端/);
    assert.equal(requests.some(url => url.includes('/auth/v1/')), false);
  } finally {
    if (client?.timer) clearInterval(client.timer);
    client?.releaseLock?.();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(global, name, descriptor);
      else delete global[name];
    }
  }
});
