const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '浙江民办校作战地图.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('const app = {'));
const storageKey = 'zhejiang_private_school_battle_map';
const plain = value => JSON.parse(JSON.stringify(value));
const decode = value => String(value??'').replace(/&quot;|&#39;|&lt;|&gt;|&amp;/g, entity=>({'&quot;':'"','&#39;':"'",'&lt;':'<','&gt;':'>','&amp;':'&'}[entity]));
const attrs = markup => Object.fromEntries([...markup.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m=>[m[1],m[2]===undefined?true:decode(m[2])]));

function classList(initial='') {
  const values = new Set(initial.split(/\s+/).filter(Boolean));
  return {add(value){values.add(value);},remove(value){values.delete(value);},contains(value){return values.has(value);},toggle(value,force){const state=force===undefined?!values.has(value):force;state?values.add(value):values.delete(value);return state;}};
}

// The VM uses the same inline application script as ui-data.test.cjs. This
// fixture represents controls rendered by openPersonModal and preserves their
// identities, hidden state and checked values through the real filtering/save
// methods. It does not substitute a second selection implementation.
function load(data=fixture()) {
  const records = new Map([[storageKey,JSON.stringify(data)],['zhejiang_app_ver','6']]);
  const elements = new Map([['contextMenu',{addEventListener(){}}]]);
  let markup = '';
  let form;
  function controlFromAttributes(a) {
    return {name:a.name,value:a.value===undefined?'':String(a.value),checked:a.checked===true,type:a.type||'text',
      hidden:a.hidden===true,classList:classList(a.class||''),dataset:Object.fromEntries(Object.entries(a).filter(([k])=>k.startsWith('data-')).map(([k,v])=>[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()),v])),
      getAttribute(name){return a[name]===undefined?null:a[name]===true?'':a[name];},addEventListener(){}};
  }
  function parseForm(value) {
    for(const id of ['personForm','personSchoolEmpty','personSchoolSelectionInfo']) elements.delete(id);
    const match=value.match(/<form\b[^>]*id="personForm"[^>]*>([\s\S]*?)<\/form>/);
    if(!match){form=undefined;return;}
    const inner=match[1];
    const controls=[...inner.matchAll(/<input\b([^>]*)>/g)].map(m=>controlFromAttributes(attrs(m[1])));
    for(const m of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const a=attrs(m[1]);
      const options=[...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(x=>({a:attrs(x[1]),label:decode(x[2])}));
      const selected=options.find(o=>o.a.selected===true)||options[0];
      controls.push(controlFromAttributes({...a,value:selected?.a.value||''}));
    }
    const rows=[...inner.matchAll(/<label\b([^>]*\bdata-person-school-row\b[^>]*)>([\s\S]*?)<\/label>/g)].map(m=>{
      const a=attrs(m[1]);
      const ia=attrs((m[2].match(/<input\b([^>]*)>/)||[])[1]||'');
      const checkbox=controls.find(c=>c.name==='schoolIds'&&c.value===ia.value);
      const row=controlFromAttributes(a);
      row.checkbox=checkbox;
      row.querySelector=()=>checkbox;
      return row;
    });
    function selectAll(selector) {
      if(selector==='[data-person-school-row]') return rows;
      const m=selector.match(/^(?:input)?\[name=["']([^"']+)["']\](:checked)?$/);
      if(m) return controls.filter(c=>c.name===m[1]&&(!selector.startsWith('input')||c.type!=='select')&&(!m[2]||c.checked));
      throw new Error('Unsupported fixture selector: '+selector);
    }
    form={controls,rows,querySelectorAll:selectAll,querySelector(selector){return selectAll(selector)[0]||null;},reportValidity(){return true;},checkValidity(){return true;}};
    elements.set('personForm',form);
    for(const id of ['personSchoolEmpty','personSchoolSelectionInfo']) {
      const node=inner.match(new RegExp('<(?:div|p|span)\\b([^>]*id="'+id+'"[^>]*)>([\\s\\S]*?)<\\/(?:div|p|span)>'));
      if(node){const a=attrs(node[1]);elements.set(id,{hidden:a.hidden===true,classList:classList(a.class||''),textContent:decode(node[2].replace(/<[^>]+>/g,'')),innerHTML:node[2]});}
    }
  }
  const content={get innerHTML(){return markup;},set innerHTML(value){markup=value;parseForm(value);}};
  const overlay={classList:classList('hidden')};
  elements.set('modalContent',content);elements.set('modalOverlay',overlay);
  const document={addEventListener(){},querySelectorAll(){return [];},getElementById(id){return elements.get(id)||null;},createElement(){return {classList:classList(),addEventListener(){}};}};
  class FixtureFormData {
    constructor(target){this.form=target;}
    get(name){const c=this.form.controls.find(c=>c.name===name&&(c.type!=='checkbox'||c.checked));return c?c.value:null;}
    getAll(name){return this.form.controls.filter(c=>c.name===name&&(c.type!=='checkbox'||c.checked)).map(c=>c.value);}
  }
  const context=vm.createContext({document,window:{addEventListener(){}},console:{warn(){}},FormData:FixtureFormData,
    localStorage:{getItem(k){return records.has(k)?records.get(k):null;},setItem(k,v){records.set(k,String(v));},removeItem(k){records.delete(k);}},setTimeout(){return 1;},clearTimeout(){}});
  vm.runInContext(source+'\nglobalThis.app=app; globalThis.store=store;',context);
  const app=context.app;app.data=plain(data);app.toast=()=>{};app.refreshPage=()=>{};
  const getForm=()=>elements.get('personForm');
  const setCity=(city,checked)=>{const c=getForm().controls.find(c=>c.name==='cities'&&c.value===city);assert.ok(c,'city control '+city);c.checked=checked;app.updatePersonSchoolOptions();};
  const setSchool=(id,checked)=>{const c=getForm().controls.find(c=>c.name==='schoolIds'&&c.value===id);assert.ok(c,'school control '+id);c.checked=checked;app.updatePersonSchoolOptions();};
  const visibleIds=()=>getForm().rows.filter(r=>!r.hidden&&!r.classList.contains('hidden')).map(r=>r.checkbox.value);
  return {app,context,records,elements,getForm,setCity,setSchool,visibleIds,markup:()=>markup};
}

function fixture(personOverrides={}) {
  return {schools:[{id:'S_H1',name:'杭州一校',city:'杭州市'},{id:'S_H2',name:'杭州二校',city:'杭州市'},{id:'S_N1',name:'宁波一校',city:'宁波市'},{id:'S_W1',name:'温州一校',city:'温州市'},{id:'S_NONE',name:'无地市学校',city:''}],
    deliveries:[],opportunities:[],stakeholders:[],logs:[],
    persons:[{id:'P1',name:'负责人',role:'驻点销售',cities:['杭州市'],schoolIds:[],phone:'13900000000',status:'在职',...personOverrides}]};
}

test('person school checkboxes show only selected cities and keep same-city multi-selection',()=>{
  const {app,visibleIds,setSchool,getForm}=load();
  app.openPersonModal('P1');
  assert.deepEqual(visibleIds(),['S_H1','S_H2']);
  const controls=getForm().controls.filter(c=>c.name==='schoolIds');
  assert.ok(controls.every(c=>c.type==='checkbox'));
  setSchool('S_H1',true);setSchool('S_H2',true);
  assert.deepEqual(getForm().controls.filter(c=>c.name==='schoolIds'&&c.checked).map(c=>c.value),['S_H1','S_H2']);
  assert.deepEqual(app.data.persons[0].schoolIds,[]);
});

test('city changes filter immediately while cross-city selections and checkbox identities survive',()=>{
  const {app,visibleIds,setCity,setSchool,getForm}=load();app.openPersonModal('P1');
  const initial=getForm().controls.filter(c=>c.name==='schoolIds');
  setSchool('S_H1',true);setCity('宁波市',true);setSchool('S_N1',true);
  assert.deepEqual(visibleIds(),['S_H1','S_H2','S_N1']);
  setCity('杭州市',false);
  assert.deepEqual(visibleIds(),['S_N1']);
  assert.equal(getForm().controls.find(c=>c.value==='S_H1').checked,true);
  setCity('杭州市',true);
  assert.deepEqual(visibleIds(),['S_H1','S_H2','S_N1']);
  assert.deepEqual(getForm().controls.filter(c=>c.name==='schoolIds'),initial);
  app.savePerson('P1');
  assert.deepEqual(plain(app.data.persons[0].schoolIds),['S_H1','S_N1']);
  assert.deepEqual(plain(app.data.persons[0].cities),['杭州市','宁波市']);
});

test('no selected city shows no school options; selecting a city reveals only that city',()=>{
  const {app,elements,visibleIds,setCity}=load(fixture({cities:[]}));app.openPersonModal('P1');
  assert.deepEqual(visibleIds(),[]);
  assert.ok(elements.get('personSchoolEmpty'));
  assert.equal(elements.get('personSchoolEmpty').hidden,false);
  setCity('杭州市',true);
  assert.deepEqual(visibleIds(),['S_H1','S_H2']);
  assert.equal(elements.get('personSchoolEmpty').hidden,true);
  setCity('杭州市',false);
  assert.deepEqual(visibleIds(),[]);
  assert.equal(elements.get('personSchoolEmpty').hidden,false);
});

test('old selections outside chosen cities and deleted schools are retained with a visible count explanation',()=>{
  const {app,elements,visibleIds,getForm,records}=load(fixture({schoolIds:['S_N1','S_DELETED']}));
  app.openPersonModal('P1');
  assert.deepEqual(visibleIds(),['S_H1','S_H2']);
  assert.deepEqual(getForm().controls.filter(c=>c.name==='schoolIds'&&c.checked).map(c=>c.value).sort(),['S_DELETED','S_N1']);
  const info=elements.get('personSchoolSelectionInfo');
  assert.ok(info);assert.match(info.textContent,/2/);assert.match(info.textContent,/保留|隐藏|不在|已移除|未显示/);
  app.savePerson('P1');
  assert.deepEqual(plain(app.data.persons[0].schoolIds).sort(),['S_DELETED','S_N1']);
  assert.deepEqual(JSON.parse(records.get(storageKey)).persons[0].schoolIds.sort(),['S_DELETED','S_N1']);
});

test('saving checkbox edits preserves person metadata, versions and unrelated records',()=>{
  const data=fixture({schoolIds:['S_H1'],version:13,sourceImportDate:'2026-10-09',remark:'历史备注',custom:{source:'keep'}});
  data.deliveries=[{id:'D1',schoolId:'S_H1',confirmedRevenue:0,confirmedRevenueSource:{row:2}}];
  const original=plain(data);
  const {app,setSchool,setCity,getForm,records}=load(data);app.openPersonModal('P1');
  setSchool('S_H1',false);setSchool('S_H2',true);setCity('宁波市',true);setSchool('S_N1',true);
  getForm().controls.find(c=>c.name==='phone').value='13888888888';
  app.savePerson('P1');
  const actual=plain(app.data.persons[0]);
  assert.deepEqual(actual,{...original.persons[0],phone:'13888888888',cities:['杭州市','宁波市'],schoolIds:['S_H2','S_N1']});
  assert.deepEqual(plain(app.data.deliveries),original.deliveries);
  assert.deepEqual(plain(app.data.schools),original.schools);
  assert.equal(records.get('zhejiang_app_ver'),'6');
  assert.deepEqual(JSON.parse(records.get(storageKey)),plain(app.data));
});

test('cancel discards unsaved cities and schools; reopening renders original selections',()=>{
  const data=fixture({schoolIds:['S_H1']});
  const {app,setSchool,setCity,records,getForm}=load(data);app.openPersonModal('P1');
  setSchool('S_H1',false);setSchool('S_H2',true);setCity('宁波市',true);setSchool('S_N1',true);
  app.closeModal();
  assert.deepEqual(plain(app.data),data);
  assert.deepEqual(JSON.parse(records.get(storageKey)),data);
  app.openPersonModal('P1');
  assert.deepEqual(getForm().controls.filter(c=>c.name==='schoolIds'&&c.checked).map(c=>c.value),['S_H1']);
  assert.deepEqual(getForm().controls.filter(c=>c.name==='cities'&&c.checked).map(c=>c.value),['杭州市']);
});

test('new people save multiple schools as arrays while keeping existing people intact',()=>{
  const data=fixture();const original=plain(data.persons[0]);
  const {app,setCity,setSchool,getForm,visibleIds}=load(data);app.openPersonModal();
  assert.deepEqual(visibleIds(),[]);
  getForm().controls.find(c=>c.name==='name').value='新负责人';
  setCity('杭州市',true);setCity('宁波市',true);setSchool('S_H1',true);setSchool('S_H2',true);setSchool('S_N1',true);
  app.savePerson('P_NEW');
  assert.deepEqual(plain(app.data.persons[0]),original);
  const created=plain(app.data.persons.find(p=>p.id==='P_NEW'));
  assert.deepEqual(created.schoolIds,['S_H1','S_H2','S_N1']);assert.deepEqual(created.cities,['杭州市','宁波市']);
});

test('school names, cities and IDs are escaped yet retain exact original values for filtering and save',()=>{
  const city='历史地市"><img src=x onerror="pwned=1">';
  const id='S\');pwned=1;//" & <';
  const name='学校"><script>pwned=1</script>&';
  const data=fixture({cities:[city],schoolIds:[id]});
  data.schools.push({id,name,city});
  const {app,context,visibleIds,getForm,markup}=load(data);app.openPersonModal('P1');
  assert.doesNotMatch(markup(),/<img\b|<script\b|onerror="pwned=1"/);
  assert.match(markup(),/&lt;script&gt;/);
  assert.deepEqual(visibleIds(),[id]);
  assert.equal(getForm().controls.find(c=>c.name==='schoolIds'&&c.value===id).checked,true);
  app.updatePersonSchoolOptions();app.savePerson('P1');
  assert.deepEqual(plain(app.data.persons[0].schoolIds),[id]);assert.deepEqual(plain(app.data.persons[0].cities),[city]);
  assert.equal(context.pwned,undefined);
});
