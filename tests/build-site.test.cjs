const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
function build(config, extras = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'school-map-build-test-'));
  fs.copyFileSync(path.join(__dirname, '..', 'build-site.cjs'), path.join(dir, 'build-site.cjs'));
  fs.writeFileSync(path.join(dir, 'cloud-config.js'), 'window.SCHOOL_MAP_CLOUD=' + JSON.stringify(config));
  fs.writeFileSync(path.join(dir, '浙江民办校作战地图.html'), 'const app={\n  importInTransitData(){ const privateSeed="PRIVATE_BUSINESS_DATA"; },\n  toast(message){}\n};');
  for (const filename of ['index.html', 'cloud-sync.js', 'map-data-backup.json', '业务附件.xlsx', 'secret.env']) fs.writeFileSync(path.join(dir, filename), 'private file');
  if (extras) { fs.mkdirSync(path.join(dir, 'dist')); fs.writeFileSync(path.join(dir, 'dist', '业务附件.xlsx'), 'do not delete me'); }
  const result = spawnSync(process.execPath, ['build-site.cjs'], { cwd: dir, encoding: 'utf8' });
  return { dir, result, files: fs.existsSync(path.join(dir, 'dist')) ? fs.readdirSync(path.join(dir, 'dist')) : [] };
}
test('cloud publication excludes inline business seed, public backup, attachments and private files', () => {
  const { dir, result, files } = build({ url: 'https://test.supabase.co', publishableKey: 'sb_publishable_test', workspaceId: 'zhejiang-schools' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(files.sort(), ['.nojekyll', 'cloud-config.js', 'cloud-sync.js', 'index.html', '浙江民办校作战地图.html'].sort());
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'dist', '浙江民办校作战地图.html'), 'utf8'), /PRIVATE_BUSINESS_DATA/);
});
test('unconfigured publication keeps the original local-mode bootstrap', () => {
  const { dir, result, files } = build({ url: '', publishableKey: '' }); assert.equal(result.status, 0);
  assert.ok(files.includes('map-data-backup.json')); assert.match(fs.readFileSync(path.join(dir, 'dist', '浙江民办校作战地图.html'), 'utf8'), /PRIVATE_BUSINESS_DATA/);
});
test('publication rejects privileged keys and unrelated stale output without deleting user files', () => {
  const secret = build({ publishableKey: 'sb_secret_do_not_publish' }); assert.notEqual(secret.result.status, 0);
  const stale = build({ url: '', publishableKey: '' }, true); assert.notEqual(stale.result.status, 0);
  assert.equal(fs.readFileSync(path.join(stale.dir, 'dist', '业务附件.xlsx'), 'utf8'), 'do not delete me');
});
