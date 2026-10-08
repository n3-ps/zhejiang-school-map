/* Browser REST client; no privileged database keys or third-party runtime required. */
(function (root) {
  'use strict';
  const COLLECTIONS = ['schools', 'deliveries', 'opportunities', 'persons', 'stakeholders'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const emptyData = () => Object.fromEntries([...COLLECTIONS, 'logs'].map(c => [c, []]));
  const keyOf = (collection, id) => JSON.stringify([collection, id]);
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  function flatten(data) {
    const records = new Map();
    for (const collection of COLLECTIONS) for (const payload of data[collection] || []) {
      if (!payload.id || typeof payload.id !== 'string') throw new Error('记录缺少有效 ID，请先检查导入数据');
      const key = keyOf(collection, payload.id);
      if (records.has(key)) throw new Error('存在重复记录 ID，请先检查导入数据');
      records.set(key, { collection, id: payload.id, payload: clone(payload), deleted: false });
    }
    return records;
  }
  class RevisionQueue {
    constructor(saved) {
      this.base = new Map(saved?.base || []);
      this.pending = new Map(saved?.pending || []);
      this.snapshot = new Map();
      this.snapshot = flatten(this.materialize());
    }
    serialize() { return { base: [...this.base], pending: [...this.pending] }; }
    loadRemote(rows) {
      this.base = new Map(rows.filter(r => COLLECTIONS.includes(r.collection)).map(r => [keyOf(r.collection, r.id), clone(r)]));
      this.snapshot = flatten(this.materialize());
    }
    materialize() {
      const data = emptyData();
      const merged = new Map(this.base);
      for (const [key, change] of this.pending) merged.set(key, change);
      for (const row of merged.values()) if (!row.deleted && COLLECTIONS.includes(row.collection)) data[row.collection].push(clone(row.payload));
      return data;
    }
    observe(data) {
      const next = flatten(data);
      for (const key of new Set([...this.snapshot.keys(), ...next.keys()])) {
        const before = this.snapshot.get(key), after = next.get(key);
        if (canonical(before?.payload) === canonical(after?.payload)) continue;
        const existing = this.pending.get(key), base = this.base.get(key);
        const source = after || before;
        const change = { collection: source.collection, id: source.id, payload: after ? clone(after.payload) : { id: source.id }, deleted: !after, base_version: existing ? existing.base_version : (base?.version || 0) };
        // Keep entries until acknowledged, even when reverted: a request may be in flight.
        this.pending.set(key, change);
      }
      this.snapshot = next;
    }
    batch() { return [...this.pending.values()].map(clone); }
    acknowledge(sent, rows) {
      for (const row of rows) {
        const key = keyOf(row.collection, row.id);
        this.base.set(key, clone(row));
        const current = this.pending.get(key), original = sent.find(s => keyOf(s.collection, s.id) === key);
        if (current && original) {
          if (canonical(current) === canonical(original)) this.pending.delete(key);
          else current.base_version = row.version;
        }
      }
      this.snapshot = flatten(this.materialize());
    }
    conflicts(rows) {
      const remote = new Map(rows.map(r => [keyOf(r.collection, r.id), r]));
      return [...this.pending.values()].filter(c => (remote.get(keyOf(c.collection, c.id))?.version || 0) !== c.base_version);
    }
    reconcileAcknowledgement(rows) {
      // A timed-out request may have committed. Same payload and exactly next version is its receipt.
      const remote = new Map(rows.map(r => [keyOf(r.collection, r.id), r]));
      for (const [key, change] of this.pending) {
        const row = remote.get(key);
        if (row && row.version === change.base_version + 1 && row.deleted === change.deleted && (row.deleted || canonical(row.payload) === canonical(change.payload))) this.pending.delete(key);
      }
    }
  }
  class CloudClient {
    constructor(config, app, store) {
      this.config = config; this.app = app; this.store = store;
      this.url = config.url.replace(/\/$/, '');
      this.scope = this.url + ':' + config.workspaceId;
      this.sessionKey = 'school-map-session:' + this.scope;
      this.queueKey = 'school-map-pending:' + this.scope;
      this.recoveryKey = 'school-map-recovery:' + this.scope;
      this.queue = new RevisionQueue(); this.ready = false; this.busy = false; this.conflicted = false;
      this.originalSet = store.set.bind(store);
      this.seed = this.readStorage(localStorage, this.recoveryKey) || clone(app.data);
      this.message = '请登录云端账号';
      this.session = this.readStorage(sessionStorage, this.sessionKey);
      this.panel = null;
    }
    readStorage(storage, key) { try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; } }
    saveSession(session) { this.session = session; if (session) sessionStorage.setItem(this.sessionKey, JSON.stringify(session)); else sessionStorage.removeItem(this.sessionKey); }
    persist() {
      localStorage.setItem(this.queueKey, JSON.stringify({ userId: this.session?.user?.id, ...this.queue.serialize() }));
    }
    setStatus(message, connected = false) {
      this.message = message;
      const el = document.getElementById('cloudSaveStatus'); if (el) el.textContent = message;
      const mode = document.getElementById('storageModeLabel');
      if (mode) mode.textContent = !this.session ? '本地暂存 · 待登录' : connected && this.ready && navigator.onLine && !this.queue.pending.size && !this.conflicted ? '数据云端同步' : '云端同步 · 本地暂存';
      const icon = document.getElementById('storageModeIcon'); if (icon) icon.className = this.session ? 'ri-cloud-line' : 'ri-hard-drive-2-line';
      this.renderPanel();
    }
    async auth(path, body) {
      const response = await fetch(this.url + '/auth/v1/' + path, { method: 'POST', headers: { apikey: this.config.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.msg || result.error_description || '登录失败，请检查邮箱和密码'); error.status = response.status; throw error; }
      result.expires_at = Math.floor(Date.now() / 1000) + result.expires_in;
      return result;
    }
    async ensureSession() {
      if (!this.session) throw new Error('请先登录');
      if ((this.session.expires_at || 0) > Date.now() / 1000 + 60) return;
      if (!this.refreshing) this.refreshing = this.auth('token?grant_type=refresh_token', { refresh_token: this.session.refresh_token }).then(s => this.saveSession(s)).finally(() => { this.refreshing = null; });
      try { await this.refreshing; } catch (error) {
        if (error.status === 400 || error.status === 401 || error.status === 403) { this.ready = false; this.saveSession(null); this.setStatus('登录已过期，待同步修改已保留'); }
        throw error;
      }
    }
    async request(path, options = {}) {
      await this.ensureSession();
      const response = await fetch(this.url + '/rest/v1/' + path, { ...options, headers: { apikey: this.config.publishableKey, Authorization: 'Bearer ' + this.session.access_token, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.message || '云端请求失败'); error.code = result.code; throw error; }
      return result;
    }
    async readRows() {
      const result = await this.request('rpc/read_school_map_snapshot', { method: 'POST', body: JSON.stringify({ p_workspace_id: this.config.workspaceId }) });
      return result.records;
    }
    replaceApp() {
      const data = this.queue.materialize(); data.logs = this.app.data.logs || [];
      this.originalSet(data); this.app.data = data;
      // Preserve an open form; its next save is version-checked against the last displayed data.
      const modal = document.getElementById('modalOverlay');
      if (!modal || modal.classList.contains('hidden')) this.app.refreshPage();
      else this.remoteRefreshDeferred = true;
      this.app.updateStorageInfo();
    }
    async connect() {
      if (this.connecting) return;
      this.connecting = true;
      try {
      this.ready = false; this.setStatus('正在读取云端数据…');
      const members = await this.request('school_map_members?workspace_id=eq.' + encodeURIComponent(this.config.workspaceId) + '&user_id=eq.' + encodeURIComponent(this.session.user.id) + '&select=user_id');
      if (!members.length) throw new Error('此账号没有该沙盘的访问权限，请联系管理员添加成员');
      const saved = this.readStorage(localStorage, this.queueKey);
      if (saved?.pending?.length && saved.userId !== this.session.user.id) throw new Error('此浏览器有其他账号的待同步修改，请先用原账号登录并处理');
      this.queue = new RevisionQueue(saved?.userId === this.session.user.id ? saved : null);
      const rows = await this.readRows();
      this.queue.reconcileAcknowledgement(rows);
      this.conflicted = this.queue.conflicts(rows).length > 0;
      this.queue.loadRemote(rows);
      if (!localStorage.getItem(this.recoveryKey)) localStorage.setItem(this.recoveryKey, JSON.stringify(this.seed));
      this.app.closeModal();
      this.ready = true; this.replaceApp(); this.persist();
      this.setStatus(this.conflicted ? '存在编辑冲突，待同步修改已保留' : this.queue.pending.size ? '有待同步修改' : rows.length ? '已连接云端' : '云端为空，可导入原有数据', true);
      if (!this.conflicted) void this.flush();
      } finally { this.connecting = false; }
    }
    async login(email, password) {
      if (this.readOnlyTab) { this.setStatus('另一标签页正在编辑，请在原标签页使用云端同步'); return; }
      if (this.connecting || this.authenticating) { this.setStatus('正在连接，请稍后再登录'); return; }
      this.authenticating = true;
      this.setStatus('正在登录…');
      try { this.saveSession(await this.auth('token?grant_type=password', { email, password })); await this.connect(); }
      catch (error) { this.setStatus(error.message); }
      finally { this.authenticating = false; }
    }
    attach() {
      this.store.set = data => {
        this.originalSet(data);
        this.queue.observe(data); this.persist();
        this.setStatus(navigator.onLine ? '保存中…' : '已暂存本机，联网后同步');
        void this.flush();
      };
      for (const name of ['saveSchool', 'saveDelivery', 'saveOpportunity', 'saveStakeholder', 'savePerson', 'deleteSchool', 'deleteDelivery', 'deleteOpportunity', 'deleteStakeholder', 'deletePerson', 'importCSV']) {
        const original = this.app[name].bind(this.app);
        this.app[name] = (...args) => { if (!this.ready || this.conflicted) { this.app.toast(this.conflicted ? '请先处理云端编辑冲突' : '请先登录并连接云端', 'warning'); this.openPanel(); return; } return original(...args); };
      }
      const toast = this.app.toast.bind(this.app);
      this.app.toast = (message, type) => toast((message === '保存成功' || message === '删除成功') ? '已暂存，云端状态见顶部' : message, type);
      const closeModal = this.app.closeModal.bind(this.app);
      this.app.closeModal = () => { closeModal(); if (this.remoteRefreshDeferred) { this.remoteRefreshDeferred = false; this.app.refreshPage(); } };
      window.addEventListener('online', () => { void this.tick(); });
      window.addEventListener('offline', () => this.setStatus('已离线，修改将暂存本机；联网后同步'));
      window.addEventListener('beforeunload', event => { if (this.queue.pending.size) { event.preventDefault(); event.returnValue = ''; } });
      this.timer = setInterval(() => { if (document.visibilityState !== 'hidden') void this.tick(); }, Math.max(3000, this.config.pollIntervalMs || 5000));
      if (this.session && !this.readOnlyTab) this.connect().catch(error => this.setStatus(error.message));
    }
    async flush() {
      if (this.busy || !this.ready || this.conflicted || !this.queue.pending.size || !navigator.onLine) return;
      this.busy = true;
      try {
        while (this.queue.pending.size && !this.conflicted) {
          const sent = this.queue.batch();
          const result = await this.request('rpc/apply_school_map_changes', { method: 'POST', body: JSON.stringify({ p_workspace_id: this.config.workspaceId, p_changes: sent }) });
          this.queue.acknowledge(sent, result.records); this.persist();
        }
        this.setStatus('已保存到云端 · ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), true);
      } catch (error) {
        if (error.code === '40001') { this.conflicted = true; this.setStatus('存在编辑冲突，请打开云端同步处理'); }
        else if (error.code === '42501') { this.ready = false; this.setStatus('云端权限不足，待同步修改已保留，请联系管理员'); }
        else if (!this.session) this.setStatus('登录已过期，待同步修改已保留，请重新登录');
        else this.setStatus('云端保存失败，已暂存本机；将自动重试');
      } finally { this.busy = false; }
    }
    async tick() {
      if (this.busy || !this.ready || this.conflicted || !navigator.onLine) return;
      // Never pull into an open form: keep the version that the editor actually saw.
      const modal = document.getElementById('modalOverlay');
      if (modal && !modal.classList.contains('hidden')) { await this.flush(); return; }
      this.busy = true;
      try {
        const rows = await this.readRows();
        // A form can be opened while the fetch is in flight. Never advance its base version.
        const currentModal = document.getElementById('modalOverlay');
        if (currentModal && !currentModal.classList.contains('hidden')) return;
        this.queue.reconcileAcknowledgement(rows);
        if (this.queue.conflicts(rows).length) { this.conflicted = true; this.setStatus('存在编辑冲突，请打开云端同步处理'); return; }
        const before = canonical(this.queue.materialize()); this.queue.loadRemote(rows); this.persist();
        if (before !== canonical(this.queue.materialize())) this.replaceApp();
        if (!this.queue.pending.size) this.setStatus('已同步云端 · ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), true);
      } catch (error) {
        if (error.code === '42501') { this.ready = false; this.setStatus('云端权限已被撤销，本地数据已保留，请联系管理员'); }
        else if (!this.session) this.setStatus('登录已过期，待同步修改已保留，请重新登录');
        else this.setStatus('云端连接失败，本地数据已保留；将自动重试');
      }
      finally { this.busy = false; }
      await this.flush();
    }
    download(data, prefix) { this.app.downloadFile(JSON.stringify(data, null, 2), prefix + '_' + Date.now() + '.json', 'application/json'); }
    async seedCloud() {
      if (!this.ready || this.busy || this.conflicted || this.queue.base.size || this.queue.pending.size) return;
      if (!confirm('将本机原有数据导入当前空云端沙盘？请确认这份数据是团队要使用的版本。')) return;
      this.download(this.seed, '迁移前备份'); this.queue.observe(this.seed); this.persist(); this.replaceApp(); await this.flush();
    }
    async chooseMigrationBackup(file) {
      if (!file) return;
      let data = JSON.parse(await file.text());
      if (data[this.store.key]) data = typeof data[this.store.key] === 'string' ? JSON.parse(data[this.store.key]) : data[this.store.key];
      if (!COLLECTIONS.every(c => Array.isArray(data[c]))) throw new Error('备份文件缺少学校、交付、商机、人员或干系人数组');
      flatten(data); // Reject duplicate/missing IDs before changing the migration source.
      this.seed = { ...emptyData(), ...data };
      localStorage.setItem(this.recoveryKey, JSON.stringify(this.seed));
      this.setStatus('已选择迁移备份，尚未上传云端');
    }
    async resolveCloud() {
      if (this.busy || !this.ready || !confirm('会先下载包含本地修改的备份，再采用最新云端数据。本地未同步修改可从备份重新整理。是否继续？')) return;
      this.download(this.queue.materialize(), '冲突本地备份');
      this.busy = true;
      try { const rows = await this.readRows(); this.app.closeModal(); this.queue = new RevisionQueue(); this.queue.loadRemote(rows); this.conflicted = false; this.persist(); this.replaceApp(); this.setStatus('已采用最新云端数据', true); }
      catch (error) { this.setStatus('读取失败，本地修改仍保留'); }
      finally { this.busy = false; }
    }
    async logout() {
      if (this.busy || this.connecting || this.authenticating) { this.setStatus('正在同步，请稍后再退出'); return; }
      if (this.queue.pending.size) { this.setStatus('请先同步待保存修改或处理冲突，再退出'); return; }
      this.ready = false;
      try { if (this.session) await fetch(this.url + '/auth/v1/logout?scope=local', { method: 'POST', headers: { apikey: this.config.publishableKey, Authorization: 'Bearer ' + this.session.access_token }, signal: AbortSignal.timeout(10000) }); } catch { /* Clear local session even if disconnected. */ }
      this.saveSession(null); this.app.closeModal(); this.queue = new RevisionQueue(); this.app.data = emptyData(); this.originalSet(this.app.data); this.app.refreshPage(); this.setStatus('已退出，请登录云端账号');
    }
    openPanel() {
      if (!this.panel) {
        this.panel = document.createElement('dialog'); this.panel.className = 'cloud-dialog'; document.body.appendChild(this.panel);
      }
      if (!this.panel.open) this.panel.showModal(); this.renderPanel();
    }
    renderPanel() {
      if (!this.panel?.open) return;
      // Avoid replacing inputs while somebody is typing a password.
      if (this.panel.querySelector('form') && !this.ready) { const status = this.panel.querySelector('[data-status]'); if (status) status.textContent = this.message; return; }
      this.panel.replaceChildren();
      const heading = document.createElement('h3'); heading.textContent = '云端同步'; this.panel.appendChild(heading);
      const status = document.createElement('p'); status.dataset.status = ''; status.textContent = this.message; this.panel.appendChild(status);
      const button = (text, action) => { const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.addEventListener('click', () => Promise.resolve(action()).catch(e => this.setStatus(e.message))); this.panel.appendChild(el); };
      if (!this.ready) {
        const form = document.createElement('form');
        const email = document.createElement('input'); email.type = 'email'; email.placeholder = '管理员添加的账号邮箱'; email.autocomplete = 'username'; email.required = true;
        const password = document.createElement('input'); password.type = 'password'; password.placeholder = '密码'; password.autocomplete = 'current-password'; password.required = true;
        const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '登录并连接';
        form.append(email, password, submit); form.addEventListener('submit', async e => { e.preventDefault(); const value = password.value; password.value = ''; submit.disabled = true; try { await this.login(email.value.trim(), value); } finally { submit.disabled = false; } });
        this.panel.appendChild(form);
      } else {
        const user = document.createElement('p'); user.textContent = this.session.user.email; this.panel.appendChild(user);
        button('立即同步', () => this.tick());
        button('下载当前数据备份', () => this.download(this.app.data, '沙盘备份'));
        if (this.conflicted) button('备份本地修改并采用云端版本', () => this.resolveCloud());
        if (!this.queue.base.size && !this.queue.pending.size) {
          const summary = document.createElement('p'); summary.textContent = `迁移来源：${this.seed.schools.length} 所学校、${this.seed.deliveries.length} 项交付、${this.seed.opportunities.length} 个商机`; this.panel.appendChild(summary);
          const label = document.createElement('label'); label.textContent = '也可选择原网页导出的 JSON 备份作为迁移来源：';
          const file = document.createElement('input'); file.type = 'file'; file.accept = '.json,application/json'; file.addEventListener('change', () => this.chooseMigrationBackup(file.files[0]).catch(e => this.setStatus(e.message)));
          label.appendChild(file); this.panel.appendChild(label);
          button('将原有数据导入空云端', () => this.seedCloud());
        }
        button('退出登录', () => this.logout());
      }
      button('关闭', () => this.panel.close());
    }
  }
  async function boot(app, store) {
    await app.init();
    const config = root.SCHOOL_MAP_CLOUD || {};
    const status = document.getElementById('cloudSaveStatus'), button = document.getElementById('cloudSyncButton');
    if (!config.url || !config.publishableKey) {
      if (status) status.textContent = '已保存本机 · 云端待配置';
      if (button) button.onclick = () => app.toast('请按 CLOUD_SETUP.md 创建项目并填写 cloud-config.js', 'info');
      return null;
    }
    if (!/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/?$/.test(config.url) || !config.workspaceId || config.publishableKey.startsWith('sb_secret_')) {
      if (status) status.textContent = '云端配置无效，请检查公开配置'; return null;
    }
    // Legacy JWT service_role keys must never be accepted in a browser.
    if (config.publishableKey.startsWith('eyJ')) {
      try { const jwt = JSON.parse(atob(config.publishableKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); if (jwt.role !== 'anon') throw new Error('仅允许 anon key'); }
      catch { if (status) status.textContent = '请使用 Publishable key 或 anon key'; return null; }
    }
    const client = new CloudClient(config, app, store); root.schoolMapCloud = client;
    // One writer per browser profile prevents tabs from overwriting the persistent outbox.
    if (navigator.locks) await new Promise(resolve => {
      navigator.locks.request('school-map-writer:' + client.scope, { ifAvailable: true }, lock => {
        client.readOnlyTab = !lock; resolve();
        if (lock) return new Promise(release => { client.releaseLock = release; });
      }).catch(() => { client.readOnlyTab = true; resolve(); });
    });
    else client.readOnlyTab = true;
    client.setStatus(client.readOnlyTab ? '另一标签页正在编辑或浏览器不支持编辑锁，此页只读' : client.session ? '正在连接云端…' : '请登录云端账号');
    client.attach(); if (button) button.onclick = () => client.openPanel();
    return client;
  }
  const api = { RevisionQueue, CloudClient, boot, canonical, emptyData, COLLECTIONS };
  root.SchoolMapCloud = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
