const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const html = fs.readFileSync(path.join(__dirname, '..', '浙江民办校作战地图.html'), 'utf8');
const start = html.indexOf('  csvHeaders(');
const end = html.indexOf('  exportAllData(){', start);
assert.ok(start >= 0 && end > start, 'CSV methods exist');
let saves = 0;
let result = { classList: { remove() {} }, textContent: '' };
const controls = {
  importType: { value: '' },
  importFile: { files: [] }
};
const context = vm.createContext({
  document: { getElementById: id => id === 'importResult' ? result : controls[id] },
  store: { set() { saves++; } },
  FileReader: class {
    readAsText(file) { this.onload({ target: { result: file.content } }); }
  },
  console
});
const app = vm.runInContext('({' + html.slice(start, end) + '})', context);
app.refreshPage = () => { result = { classList: { remove() {} }, textContent: '' }; };
app.toast = message => { throw new Error(message); };
app.personName = id => app.data.persons.find(p => p.id === id)?.name || id;
let exported;
app.downloadFile = content => { exported = content; };
const normal = value => JSON.parse(JSON.stringify(value));
const sample = {
  schools: [{ id: 'S1', name: '学校,"甲"', city: '杭州市', district: '滨江区', schoolType: ['小学', '初中'], principal: '李,"校长"', principalTitle: '校长', contact: '王老师', contactTitle: '老师', phone: '13800000000', wechatEmail: 'a@b.cn', signDate: '2026-01-01', totalAmount: 0, remark: '首行\r\n次行,带"引号"' }],
  persons: [{ id: 'P1', name: '张,"老师"', role: '驻点销售', cities: ['杭州市'], schoolIds: ['S1'], phone: '13900000000', status: '在职' }],
  deliveries: [{ id: 'D1', schoolId: 'S1', name: '交付,"一"', productTypes: ['智慧黑板', '录播'], quantities: { 智慧黑板: 0, 录播: 2 }, deployLocation: '楼1,楼2', progress: '交付中', managerId: 'P1', planDate: '2026-11-01', actualDate: '', confirmedRevenue: 0, remark: '第一行\n第二行' }],
  opportunities: [{ id: 'O1', schoolId: 'S1', name: '商机,"一"', stage: '方案交流', products: ['录播'], amount: 1234.5, signDate: '2026-12-01', salesId: 'P1', milestones: '推进,"节点"\n下一步', risks: '风险,"甲"\n乙', remark: '' }],
  stakeholders: [{ id: 'ST1', schoolId: 'S1', name: '周,"主任"', title: '主任', phone: '13700000000', wechatEmail: 'a,b@c.cn', type: '对接人', records: '记录,"双引号"\n第二行' }]
};
const importText = (type, content) => {
  controls.importType.value = type;
  controls.importFile.files = [{ content }];
  app.importCSV();
  return result.textContent;
};
const csv = (type, rows, includeIds = false) => '\uFEFF' + [app.csvHeaders(type, includeIds), ...rows].map(row => row.map(v => app.csvField(v)).join(',')).join('\r\n');

app.data = normal(sample);
for (const type of Object.keys(sample)) {
  app.exportCSV(type);
  const parsed = app.parseCSV(exported);
  assert.equal(parsed.length, 2, `${type}: one header and one record`);
  assert.equal(parsed[0].values.length, parsed[1].values.length, `${type}: equal column counts`);
  assert.match(importText(type, exported), /更新 1 条，失败 0 条/);
  assert.match(importText(type, exported), /更新 1 条，失败 0 条/);
  assert.deepEqual(normal(app.data[type]), sample[type], `${type}: exact round trip, no duplicate`);
}
assert.equal(app.csvField(0), '0', 'numeric zero preserved');
assert.equal(app.csvNumber('1,234.50', '金额'), 1234.5, 'quoted thousands accepted');
for (const invalid of ['abc', '-1', 'Infinity', '1,23', 'NaN']) {
  assert.throws(() => app.csvNumber(invalid, '金额'), /非负数字/);
}
for (const invalid of ['{broken', '[]', 'null', '{"黑板":-1}', '{"黑板":null}', '{"黑板":true}', '{"黑板":""}']) {
  assert.throws(() => app.safeJson(invalid));
}
assert.deepEqual(normal(app.parseCSV('\uFEFFa,b\r\n"x\r\ny","""quoted"",comma"\r\n')[1]), { values: ['x\r\ny', '"quoted",comma'], line: 2 });
assert.equal(app.parseCSV('a,b\n"x\ny",z\nnext,row')[2].line, 4, 'physical row numbers after multiline fields');
assert.throws(() => app.parseCSV('a,b\n"open,z'), /没有闭合/);
assert.throws(() => app.parseCSV('a,b\nx"bad,z'), /引号位置/);
assert.throws(() => app.parseCSV('a,b\n"x"bad,z'), /多余内容/);

const oldOpportunity = ['学校,"甲"', '旧模板商机', '初步接触', '录播', '12', '', '张,"老师"', '节点\n继续', '', ''];
assert.match(importText('opportunities', csv('opportunities', [oldOpportunity])), /新增 1 条，更新 0 条，失败 0 条/);
assert.match(importText('opportunities', csv('opportunities', [oldOpportunity])), /新增 0 条，更新 1 条，失败 0 条/);
assert.equal(app.data.opportunities.find(o => o.name === '旧模板商机').salesId, 'P1', 'owner name mapped');
assert.equal(app.data.opportunities.length, 2, 'legacy CSV repeated import deduplicated');
const badAmount = [...oldOpportunity]; badAmount[1] = '错误金额'; badAmount[4] = 'not a number';
const badOwner = [...oldOpportunity]; badOwner[1] = '错误负责人'; badOwner[6] = '<b>不存在</b>';
const before = JSON.stringify(app.data);
const saveCount = saves;
const errorText = importText('opportunities', csv('opportunities', [badAmount, badOwner]));
assert.match(errorText, /失败 2 条/);
assert.match(errorText, /第2行：预计签约金额/);
assert.match(errorText, /负责人“<b>不存在<\/b>”不存在/);
assert.equal(JSON.stringify(app.data), before, 'invalid rows do not mutate data');
assert.equal(saves, saveCount, 'all-invalid import does not persist');
assert.match(importText('deliveries', csv('opportunities', [oldOpportunity])), /缺少表头/, 'wrong import type rejected');
assert.match(importText('schools', '\uFEFF' + app.csvHeaders('schools').join(',') + '\r\n'), /只有表头/, 'empty import reported');

app.data.schools.push({ ...sample.schools[0], id: 'S2', city: '宁波市' });
assert.match(importText('opportunities', csv('opportunities', [oldOpportunity])), /有重名/, 'ambiguous school name rejected');
app.exportCSV('opportunities');
assert.match(importText('opportunities', exported), /失败 0 条/, 'exported reference IDs resolve duplicate names');
console.log('CSV checks passed: five-type round trips, standard quoting/newlines, duplicate import, owner mapping, numeric/JSON validation, physical-line errors, and reference IDs.');
