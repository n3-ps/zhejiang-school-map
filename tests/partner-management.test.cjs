const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '浙江民办校作战地图.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('const app = {'));
const key = 'zhejiang_private_school_battle_map';
const plain = value => JSON.parse(JSON.stringify(value));
const decode = value => String(value ?? '').replace(/&quot;|&#39;|&lt;|&gt;|&amp;/g, entity => ({'&quot;':'"','&#39;':"'",'&lt;':'<','&gt;':'>','&amp;':'&'}[entity]));
const attrs = value => Object.fromEntries([...value.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1], m[2] === undefined ? true : decode(m[2])]));
const legacy = () => ({schools:[],deliveries:[],opportunities:[],persons:[{id:'P1',name:'现有负责人',role:'服务人员',phone:'13900000000',cities:['杭州市'],schoolIds:[],status:'在职'}],stakeholders:[],logs:[]});
const channel = () => ({id:'CH1',name:'渠道,"杭州"',cities:['杭州市','宁波市'],productTypes:['智慧课堂','批阅机'],contact:'陈,"老师"',phone:'13800000000',wechatEmail:'contact,a@b.cn',address:'办公楼1/2层',cooperationStatus:'合作中',managerId:'P1',remark:'第一行\n第二行,"备注"'});
const point = () => ({id:'SP1',name:'宁波服务站',cities:['宁波市','绍兴市'],productTypes:['智慧操场','好奇窗'],contact:'维修联系人',phone:'13700000000',wechatEmail:'service@b.cn',address:'服务园区',serviceScope:['安装施工','售后维修','培训支持'],serviceStatus:'服务中',managerId:'P1',remark:'营业日\r\n预约支持'});
const fixture = () => ({...legacy(),channels:[channel()],servicePoints:[point()]});

// Controls are parsed from the actual emitted forms. The fixture supplies DOM
// and FormData behavior only; all filtering, CSV and persistence use app code.
function load(data = fixture()) {
  const records = new Map([[key, JSON.stringify(data)]]);
  const elements = new Map([['contextMenu', {addEventListener(){}}], ['importResult',{textContent:'',classList:{remove(){}}}]]);
  let markup = '', exported, confirmation = true;
  const notices = [];
  let saves = 0;
  const document = {
    addEventListener(){},querySelectorAll(){return [];},getElementById(id){return elements.get(id)||null;},
    createElement(tag){
      if(tag==='template') {
        const node={content:{querySelector(){return {innerHTML:node.innerHTML.match(/<tbody>([\s\S]*?)<\/tbody>/)[1]};}}};
        return node;
      }
      return {classList:{add(){},remove(){},toggle(){}},addEventListener(){}};
    }
  };
  class FormDataFixture {
    constructor(form){this.controls=form.controls;}
    get(name){return this.controls.find(c=>c.name===name&&(c.type!=='checkbox'||c.checked))?.value??null;}
    getAll(name){return this.controls.filter(c=>c.name===name&&(c.type!=='checkbox'||c.checked)).map(c=>c.value);}
  }
  const context=vm.createContext({document,window:{addEventListener(){}},console:{warn(){}},FormData:FormDataFixture,
    confirm:()=>confirmation,setTimeout(){return 1;},clearTimeout(){},fetch:async()=>{throw new Error('should not fetch');},
    FileReader:class {readAsText(file){this.onload({target:{result:file.content}});}},
    localStorage:{getItem(k){return records.get(k)??null;},setItem(k,v){records.set(k,String(v));if(k===key)saves++;},removeItem(k){records.delete(k);}}});
  vm.runInContext(source+'\nglobalThis.app=app;globalThis.store=store;',context);
  const app=context.app;
  app.data=context.store.get();app.toast=(...args)=>notices.push(args);app.refreshPage=()=>{};app.closeModal=()=>{};
  app.bindNav=()=>{};app.bindSearch=()=>{};app.updateStorageInfo=()=>{};app.go=()=>{};
  app.openModal=value=>{
    markup=value;
    const match=value.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/);assert.ok(match,'emitted modal form');
    const id=attrs(match[1]).id,inner=match[2];
    const controls=[...inner.matchAll(/<input\b([^>]*)>/g)].map(m=>{const a=attrs(m[1]);return {...a,value:a.value??'',type:a.type??'text',checked:a.checked===true};});
    for(const m of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const a=attrs(m[1]);const options=[...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(x=>attrs(x[1]));
      controls.push({...a,type:'select',value:(options.find(o=>o.selected===true)||options[0])?.value??''});
    }
    for(const m of inner.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) controls.push({...attrs(m[1]),type:'textarea',value:decode(m[2])});
    elements.set(id,{controls,reportValidity(){return controls.every(c=>!c.required||String(c.value).trim());}});
  };
  app.downloadFile=(content,filename)=>{exported={content,filename};};
  const form=type=>elements.get(type==='channels'?'channelForm':'servicePointForm');
  const set=(type,name,value)=>{
    const controls=form(type).controls.filter(c=>c.name===name);assert.ok(controls.length,'control '+name);
    if(controls[0].type==='checkbox') controls.forEach(c=>{c.checked=value.includes(c.value);});
    else controls[0].value=value;
  };
  const saveId=()=>{
    const argument=markup.match(/onclick="app\.save(?:Channel|ServicePoint)\(([^\n]*?)\)"/)[1];
    return vm.runInNewContext(argument,{decodeURIComponent});
  };
  const importText=(type,content)=>{elements.set('importType',{value:type});elements.set('importFile',{files:[{content}]});app.importCSV();return elements.get('importResult').textContent;};
  return {app,context,document,elements,records,notices,form,set,saveId,importText,markup:()=>markup,exported:()=>exported,saves:()=>saves,confirm(value){confirmation=value;}};
}

test('legacy local ledgers get empty partner collections and refresh preserves existing partner data',async()=>{
  const data=legacy(),first=load(data);await first.app.init();
  assert.deepEqual(plain(first.app.data.channels),[]);assert.deepEqual(plain(first.app.data.servicePoints),[]);
  assert.deepEqual(JSON.parse(first.records.get(key)),data,'refresh does not overwrite the legacy saved ledger');
  const saved=fixture();saved.channels[0].sourceVersion=7;
  const second=load(saved);await second.app.init();
  assert.deepEqual(plain(second.app.data),saved);assert.deepEqual(JSON.parse(second.records.get(key)),saved);
});

test('both emitted forms support multi-select CRUD, round-trip persistence, cancellation and metadata preservation',()=>{
  const {app,set,saveId,records,confirm}=load(legacy());
  for(const [type,open,save,remove] of [['channels','openChannelModal','saveChannel','deleteChannel'],['servicePoints','openServicePointModal','saveServicePoint','deleteServicePoint']]) {
    app[open]();set(type,'name','新'+type);set(type,'cities',['杭州市','宁波市']);set(type,'productTypes',['智慧课堂','智慧操场']);set(type,'managerId','P1');set(type,'contact','真实联系人');set(type,'phone','13812345678');set(type,'wechatEmail','真实邮箱');set(type,'address','办公地址');set(type,'remark','两行\n备注');
    if(type==='servicePoints')set(type,'serviceScope',['安装施工','巡检维护']);
    const id=saveId();assert.equal(app[save](id),true);
    const original=plain(app.data[type][0]);original.customMetadata={version:3};app.data[type][0].customMetadata={version:3};
    assert.deepEqual(plain(app.data[type][0].cities),['杭州市','宁波市']);assert.equal(app.data[type][0].managerId,'P1');
    app[open](id);set(type,'name','未保存的更名');app.closeModal();assert.deepEqual(plain(app.data[type][0]),original);
    app[open](id);set(type,'name','已编辑'+type);set(type,'cities',['宁波市']);
    set(type,type==='channels'?'cooperationStatus':'serviceStatus',type==='channels'?'暂停合作':'待启用');
    assert.equal(app[save](id),true);assert.equal(app.data[type].length,1);assert.equal(app.data[type][0].name,'已编辑'+type);assert.deepEqual(plain(app.data[type][0].customMetadata),{version:3});
    assert.deepEqual(JSON.parse(records.get(key))[type],plain(app.data[type]));
    confirm(false);assert.equal(app[remove](id),false);assert.equal(app.data[type].length,1);
    confirm(true);assert.equal(app[remove](id),true);assert.deepEqual(JSON.parse(records.get(key))[type],[]);
  }
  assert.deepEqual(plain(app.data.persons),legacy().persons,'unrelated people are retained');
});

test('CSV templates and exports round-trip both partner types with references, quoted text and repeated imports',()=>{
  const env=load(),{app,importText}=env;
  for(const type of ['channels','servicePoints']) {
    const before=plain(app.data[type]);app.exportCSV(type);const csv=env.exported().content;
    assert.equal(app.parseCSV(csv)[0].values.length,app.parseCSV(csv)[1].values.length);
    assert.match(importText(type,csv),/新增 0 条，更新 1 条，失败 0 条/);
    assert.match(importText(type,csv),/新增 0 条，更新 1 条，失败 0 条/);
    assert.deepEqual(plain(app.data[type]),before);
    const old=load(legacy());assert.match(old.importText(type,csv),/新增 1 条，更新 0 条，失败 0 条/);
    assert.deepEqual(plain(old.app.data[type]),before,'CSV can populate a missing old collection');
    assert.equal(old.app.data[type][0].managerId,'P1');
  }
  app.exportAllData();const backup=JSON.parse(env.exported().content);
  assert.deepEqual(backup.channels,fixture().channels);assert.deepEqual(backup.servicePoints,fixture().servicePoints);
});

test('legacy partner CSV without IDs deduplicates and bad rows neither mutate nor save',()=>{
  const env=load(),{app,importText}=env;
  const headers=app.csvHeaders('channels',false);
  const record=['新增渠道','温州市/杭州市','批阅机','联系人','13000000000','a@b.cn','浙江地址','洽谈中','现有负责人','备注'];
  const csv=rows=>'\uFEFF'+[headers,...rows].map(row=>row.map(value=>app.csvField(value)).join(',')).join('\r\n');
  assert.match(importText('channels',csv([record])),/新增 1 条，更新 0 条，失败 0 条/);
  assert.match(importText('channels',csv([record])),/新增 0 条，更新 1 条，失败 0 条/);
  assert.equal(app.data.channels.length,2);
  const before=plain(app.data),saves=env.saves();
  const status=[...record];status[0]='错误状态';status[7]='不存在';
  const owner=[...record];owner[0]='错误负责人';owner[8]='不存在';
  assert.match(importText('channels',csv([status,owner])),/失败 2 条/);
  assert.deepEqual(plain(app.data),before);assert.equal(env.saves(),saves);
  const scopeHeaders=app.csvHeaders('servicePoints',false);
  const invalidScope=['错误服务','杭州市','批阅机','','','','','不存在的服务范围','服务中','',''];
  assert.match(importText('servicePoints',[scopeHeaders,invalidScope].map(row=>row.map(v=>app.csvField(v)).join(',')).join('\r\n')),/服务范围无效/);
  assert.deepEqual(plain(app.data.servicePoints),before.servicePoints);
});

test('global search and resource statistics cover partner products, contacts, cities, service scope and owners',()=>{
  const {app}=load();
  assert.ok(app.getSearchResults('13800000000').some(r=>r.type==='channel'));
  assert.ok(app.getSearchResults('售后维修').some(r=>r.type==='servicePoint'));
  assert.ok(app.getSearchResults('现有负责人').some(r=>r.type==='channel'));
  assert.ok(app.getSearchResults('service@b.cn').some(r=>r.type==='servicePoint'));
  assert.deepEqual(plain(app.computePartnerStats()),{channelCount:1,activeChannelCount:1,servicePointCount:1,activeServicePointCount:1});
  assert.equal(app.computeCityStats().find(c=>c.name==='宁波市').channelCount,1);
  assert.equal(app.computeCityStats().find(c=>c.name==='杭州市').servicePointCount,0);
  app.data.channels[0].cooperationStatus='暂停合作';assert.equal(app.computeProvinceStats().activeChannelCount,0);
  const dataPage={innerHTML:''};app.renderDataPage(dataPage);assert.match(dataPage.innerHTML,/value="channels"/);assert.match(dataPage.innerHTML,/value="servicePoints"/);
  assert.ok(html.indexOf('data-page="opportunities"')<html.indexOf('data-page="channels"'));
  assert.ok(html.indexOf('data-page="servicePoints"')<html.indexOf('data-page="persons"'));
});

test('partner filters compose and updating rows preserves filter controls, focused input and selection',()=>{
  const {app,elements,document}=load();
  for(const [type,prefix,render,status,keyword] of [['channels','Channel','renderChannelList','合作中','138'],['servicePoints','ServicePoint','renderServicePointList','服务中','培训支持']]) {
    app.listFilters[type]={[`filter${prefix}City`]:'宁波市',[`filter${prefix}Status`]:status,[`filter${prefix}Kw`]:keyword};
    assert.equal(app.getFilteredPartners(type).length,1);
    app.listFilters[type][`filter${prefix}City`]='温州市';assert.equal(app.getFilteredPartners(type).length,0);
    app.listFilters[type][`filter${prefix}City`]='宁波市';
    const input={value:keyword,selectionStart:2,selectionEnd:2};elements.set(`filter${prefix}Kw`,input);document.activeElement=input;
    const tbody={innerHTML:''},current={querySelector(){return tbody;}};
    const container={querySelector(){return current;},set innerHTML(_){throw new Error('must preserve the existing filter controls');}};
    app[render](container);assert.match(tbody.innerHTML,/<tr>/);
    assert.equal(document.activeElement,input);assert.equal(input.selectionStart,2);assert.equal(elements.get(`filter${prefix}Kw`),input);
    elements.delete(`filter${prefix}Kw`);assert.equal(app.filterValue(type,`filter${prefix}Kw`),keyword);
  }
});

test('list cells, modal values, custom choices and onclick IDs escape untrusted text while edits retain originals',()=>{
  const env=load(),{app,set,saveId}=env;
  const payload='"><img src=x onerror="pwned=1">\'&</textarea><script>pwned=1</script>';
  const id="CH');globalThis.pwned=1;//\"";
  const record={...channel(),id,name:payload,contact:payload,phone:payload,wechatEmail:payload,address:payload,remark:payload,cities:[payload],productTypes:[payload],cooperationStatus:payload};
  app.data.channels=[record];app.data.persons[0].name=payload;
  let table='';app.applyListMarkup=(_container,_type,markup)=>{table=markup;};app.renderChannelList({});
  assert.doesNotMatch(table,/<img\b|<script\b/);assert.match(table,/&lt;img/);
  const snapshot=plain(app.data);app.openChannelModal(id);assert.doesNotMatch(env.markup(),/<img\b|<script\b/);assert.equal(saveId(),id);
  assert.deepEqual(plain(app.data),snapshot);assert.equal(app.saveChannel(id),true);
  assert.deepEqual(plain(app.data),snapshot,'rendered escaping does not change persisted raw text');
  app.data.servicePoints[0]={...point(),name:payload,serviceScope:[payload],remark:payload};app.openServicePointModal('SP1');assert.doesNotMatch(env.markup(),/<img\b|<script\b/);
  set('servicePoints','name','正常名称');assert.equal(app.saveServicePoint('SP1'),true);assert.deepEqual(plain(app.data.servicePoints[0].serviceScope),[payload],'custom existing choices survive an edit');
});

test('missing required names and unresolved new owners are rejected without overwriting saved data',()=>{
  const env=load(),{app,set,saveId}=env;const before=plain(app.data),saves=env.saves();
  app.openChannelModal();assert.equal(app.saveChannel(saveId()),false);set('channels','name','真实渠道');set('channels','managerId','unknown');
  assert.equal(app.saveChannel(saveId()),false);assert.deepEqual(plain(app.data),before);assert.equal(env.saves(),saves);
  app.data.channels[0].managerId='deleted-person';app.openChannelModal('CH1');assert.equal(app.saveChannel('CH1'),true);assert.equal(app.data.channels[0].managerId,'deleted-person','old owner association is retained until explicitly changed');
});
