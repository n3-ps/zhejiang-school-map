// Explicit publish allowlist; never deploy the repository root or business attachments.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = __dirname;
const out = path.resolve(root, 'dist');
if (path.dirname(out) !== path.resolve(root) || path.basename(out) !== 'dist') throw new Error('Invalid publish directory');
const configSource = fs.readFileSync(path.join(root, 'cloud-config.js'), 'utf8');
const context = { window: {} }; vm.runInNewContext(configSource, context, { timeout: 1000 });
const configured = !!(context.window.SCHOOL_MAP_CLOUD?.url && context.window.SCHOOL_MAP_CLOUD?.publishableKey);
const config = context.window.SCHOOL_MAP_CLOUD || {};
if (config.publishableKey?.startsWith('sb_secret_')) throw new Error('Never publish a secret key');
if (config.publishableKey?.startsWith('eyJ')) {
  const payload = JSON.parse(Buffer.from(config.publishableKey.split('.')[1], 'base64url').toString());
  if (payload.role !== 'anon') throw new Error('Only a publishable or anon key may be shipped');
}
if (configured && (!/^https:\/\/[a-zA-Z0-9.-]+(?::\d+)?\/?$/.test(config.url) || !config.workspaceId)) throw new Error('Invalid cloud configuration');
fs.mkdirSync(out, { recursive: true });
const allowed = new Set(['index.html', '浙江民办校作战地图.html', 'cloud-config.js', 'cloud-sync.js', 'map-data-backup.json', '.nojekyll']);
if (fs.readdirSync(out).some(name => !allowed.has(name))) throw new Error('dist contains unknown files; refusing to publish unrelated content');
// This task owns only these generated files; do not recursively delete any directory.
for (const name of ['index.html', '浙江民办校作战地图.html', 'cloud-config.js', 'cloud-sync.js', 'map-data-backup.json', '.nojekyll']) {
  const target = path.join(out, name); if (fs.existsSync(target)) fs.unlinkSync(target);
}
let html = fs.readFileSync(path.join(root, '浙江民办校作战地图.html'), 'utf8');
if (configured) {
  const start = html.indexOf('  importInTransitData(){');
  const end = html.indexOf('\n  toast(message', start);
  if (start < 0 || end < start) throw new Error('Cannot locate embedded seed data; refusing to publish');
  html = html.slice(0, start) + '  importInTransitData(){ /* Cloud mode: migration uses a local backup. */ },\n' + html.slice(end);
}
fs.writeFileSync(path.join(out, '浙江民办校作战地图.html'), html);
for (const name of ['index.html', 'cloud-config.js', 'cloud-sync.js']) fs.copyFileSync(path.join(root, name), path.join(out, name));
if (!configured) fs.copyFileSync(path.join(root, 'map-data-backup.json'), path.join(out, 'map-data-backup.json'));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(configured ? 'Built cloud site: embedded business data and backup excluded.' : 'Built local-mode site: existing bootstrap backup retained; cloud not configured.');
