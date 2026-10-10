const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '浙江民办校作战地图.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const source = scripts.find(script => script.includes('const app = {'));
const key = 'zhejiang_private_school_battle_map';
const plain = value => JSON.parse(JSON.stringify(value));
const empty = () => ({schools:[],deliveries:[],opportunities:[],persons:[],stakeholders:[],channels:[],servicePoints:[],logs:[]});
const school = (id='S_CUSTOM', name='真实学校') => ({id,name,city:'杭州市',district:'拱墅区',schoolType:['初中'],principal:'校长',principalTitle:'校长',contact:'老师',contactTitle:'主任',phone:'13800000000',wechatEmail:'',signDate:'2026-10-01',totalAmount:100,remark:'用户备注'});
const delivery = (id='D_CUSTOM', progress='部署中') => ({id,schoolId:'S_CUSTOM',name:'真实交付',productTypes:['智慧课堂','批阅机'],quantities:{智慧课堂:2,批阅机:3},deployLocation:'教学楼',progress,managerId:'P_CUSTOM',planDate:'2026-10-20',actualDate:'',remark:''});
const opportunity = (id='O_CUSTOM', stage='需求对接', amount=20) => ({id,schoolId:'S_CUSTOM',name:'真实商机',stage,products:['智慧课堂'],amount,signDate:'2026-10-20',salesId:'P_CUSTOM',milestones:'',risks:'',remark:''});
const person = () => ({id:'P_CUSTOM',name:'张老师',role:'驻点销售',cities:['杭州市'],schoolIds:['S_CUSTOM'],phone:'13900000000',status:'在职'});
const fixture = () => ({...empty(),schools:[school()],deliveries:[delivery()],opportunities:[opportunity()],persons:[person()]});

function load({saved, marker, fetchResult}={}) {
  const records = new Map();
  if (saved !== undefined) records.set(key, JSON.stringify(saved));
  if (marker) records.set('zhejiang_csv_imported_v10', '1');
  records.set('zhejiang_app_ver', '5');
  const elements = new Map([['contextMenu', {addEventListener(){}}]]);
  const document = {
    addEventListener(){}, querySelectorAll(){return [];},
    getElementById(id){return elements.get(id)||null;},
    createElement(tag){
      if (tag==='template') {
        const node = {content:{querySelector(){return {innerHTML:node.innerHTML.match(/<tbody>([\s\S]*?)<\/tbody>/)[1]};}}};
        return node;
      }
      return {classList:{add(){},remove(){},toggle(){}},addEventListener(){}};
    }
  };
  let fetches = 0;
  const context = vm.createContext({document,window:{addEventListener(){}},console:{warn(){}},localStorage:{
    getItem(k){return records.has(k)?records.get(k):null;},
    setItem(k,v){records.set(k,String(v));}, removeItem(k){records.delete(k);}
  },setTimeout(){return 1;},clearTimeout(){},fetch:async()=>{
    fetches++;
    if (!fetchResult) throw new Error('offline');
    return {ok:true,json:async()=>fetchResult};
  }});
  vm.runInContext(source+'\nglobalThis.app=app; globalThis.store=store;',context);
  const app = context.app;
  app.bindNav=()=>{};app.bindSearch=()=>{};app.updateStorageInfo=()=>{};app.go=()=>{};app.toast=()=>{};
  return {app,context,records,elements,document,fetches:()=>fetches};
}

test('all inline JavaScript parses and HTML has no stray records after its closing tag',()=>{
  scripts.forEach(script=>new vm.Script(script));
  assert.match(html,/<\/html>\s*$/);
  assert.equal(source.includes('generateMockData'),false);
});

test('a configured cloud page never fetches or seeds public business data for a fresh browser',async()=>{
  const {app,context,fetches}=load();
  context.window.SCHOOL_MAP_CLOUD={url:'https://test.supabase.co',publishableKey:'public'};
  await app.init();
  assert.equal(fetches(),0); assert.deepEqual(plain(app.data),empty());
});

test('version upgrades preserve user data, custom IDs and edits without fetching or re-seeding',async()=>{
  const data=fixture();data.opportunities[0].salesId='用户更改的负责人';
  const {app,records,fetches}=load({saved:data});
  await app.init();
  assert.deepEqual(JSON.parse(records.get(key)),data);
  assert.deepEqual(plain(app.data),data);
  assert.equal(records.get('zhejiang_app_ver'),'6');
  assert.equal(fetches(),0);
});

test('an intentionally empty saved ledger stays empty on refresh',async()=>{
  const {app,records,fetches}=load({saved:empty()});
  await app.init();
  assert.deepEqual(JSON.parse(records.get(key)),empty());
  assert.equal(fetches(),0);
});

test('first initialization loads the exact backup without adding older seed records',async()=>{
  const data=fixture();
  const {app,records,fetches}=load({fetchResult:{[key]:JSON.stringify(data),unrelated:'must not be imported'}});
  await app.init();
  assert.deepEqual(plain(app.data),data);
  assert.equal(fetches(),1);
  assert.equal(records.has('unrelated'),false);
});

test('offline first initialization seeds once and respects subsequent edits and deletions',async()=>{
  const {app,records}=load();
  await app.init();
  assert.ok(app.data.schools.length>0);
  assert.ok(app.data.opportunities.length>0);
  const removed=app.data.opportunities.pop();
  app.data.opportunities[0].salesId='用户负责人';
  const after=plain(app.data);
  app.importInTransitData();
  assert.deepEqual(plain(app.data),after);
  assert.equal(app.data.opportunities.some(o=>o.id===removed.id),false);
  assert.equal(records.get('zhejiang_csv_imported_v10'),'1');
});

test('first seed import never removes custom opportunities or overwrites an edited existing record',()=>{
  const {app}=load();
  app.data=fixture();
  app.data.opportunities.push({...opportunity('OPP_O20260301710'),salesId:'用户指定',amount:999});
  app.importInTransitData();
  assert.ok(app.data.opportunities.some(o=>o.id==='O_CUSTOM'));
  assert.equal(app.data.opportunities.find(o=>o.id==='OPP_O20260301710').salesId,'用户指定');
  assert.equal(app.data.opportunities.find(o=>o.id==='OPP_O20260301710').amount,999);
});

test('province and city in-transit totals exclude completed delivery, won and lost opportunities',()=>{
  const {app}=load();app.data=fixture();
  app.data.deliveries.push(delivery('D_DONE','已完成'));
  app.data.opportunities.push(opportunity('O_LOST','已流失',100),opportunity('O_WON','已赢单',200),opportunity('O_SIGNED','已签约',300));
  const province=app.computeProvinceStats();
  const city=app.computeCityStats().find(city=>city.name==='杭州市');
  for(const stats of [province,city]) {
    assert.equal(stats.deliveryCount,1);assert.equal(stats.opportunityCount,1);assert.equal(stats.opportunityAmount,20);
  }
});

test('each product counts only its own quantity, including numeric strings and legacy product names',()=>{
  const {app}=load();
  const quantities=app.computeProductQuantities([
    delivery(),{productTypes:['智慧课堂','智慧课堂'],quantities:{智慧课堂:'4',智慧体育:2,无效:'abc',负数:-1}}
  ]);
  assert.deepEqual(plain(quantities),{智慧课堂:6,批阅机:3,智慧体育:2});
});

test('global search returns schools, people, delivery projects and opportunities',()=>{
  const {app}=load();app.data=fixture();
  assert.equal(app.getSearchResults('张老师')[0].type,'person');
  assert.equal(app.getSearchResults('13800000000')[0].type,'school');
  assert.equal(app.getSearchResults('真实交付')[0].type,'delivery');
  assert.equal(app.getSearchResults('真实商机')[0].type,'opportunity');
  assert.deepEqual(plain(app.getSearchResults('真实学校').map(result=>result.type)),['school','delivery','opportunity']);
});

test('list filter values survive rendering and existing input elements stay in place',()=>{
  const {app,elements,document}=load();app.data=fixture();
  const focused={value:'真实',selectionStart:2,selectionEnd:2};elements.set('filterKeyword',focused);document.activeElement=focused;
  app.captureListFilters('schools');
  assert.equal(app.getFilteredSchools().length,1);
  const tbody={innerHTML:'old'};
  const current={querySelector(selector){assert.equal(selector,'tbody');return tbody;}};
  const container={querySelector(){return current;},set innerHTML(_){throw new Error('must not replace inputs');}};
  app.applyListMarkup(container,'schools','<div data-list-type="schools"><table><tbody><tr><td>new</td></tr></tbody></table></div>');
  assert.equal(tbody.innerHTML,'<tr><td>new</td></tr>');
  assert.equal(elements.get('filterKeyword'),focused);assert.equal(document.activeElement,focused);assert.equal(focused.selectionStart,2);
  elements.delete('filterKeyword');assert.equal(app.filterValue('schools','filterKeyword'),'真实');
  app.listFilters.persons={filterPRole:'驻点销售',filterPStatus:'在职',filterPKw:'杭州'};
  assert.equal(app.getFilteredPersons().length,1);
  app.listFilters.persons.filterPStatus='离职';assert.equal(app.getFilteredPersons().length,0);
});

test('tables, cards, modal inputs and textareas escape hostile data without changing the stored values',()=>{
  const {app}=load();app.data=fixture();
  const payload='"><img src=x onerror="globalThis.pwned=1">\'&</textarea><script>globalThis.pwned=1</script>';
  const maliciousId='S\');globalThis.pwned=1;//" onmouseover="pwned=1';
  app.data.stakeholders.push({id:'ST\');pwned=1;//',schoolId:maliciousId,name:payload,title:payload,phone:payload,wechatEmail:payload,type:payload,records:payload});
  for(const item of [...app.data.schools,...app.data.deliveries,...app.data.opportunities,...app.data.persons]) {
    for(const field of Object.keys(item)) if(typeof item[field]==='string'&&!['id','schoolId'].includes(field)) item[field]=payload;
  }
  app.data.schools[0].id=maliciousId;
  app.data.deliveries[0].schoolId=maliciousId;app.data.opportunities[0].schoolId=maliciousId;
  app.data.schools[0].schoolType=[payload];app.data.deliveries[0].productTypes=[payload];app.data.opportunities[0].products=[payload];
  app.data.persons[0].cities=[payload];
  const original=plain(app.data);
  const outputs=[];app.applyListMarkup=(_container,_type,markup)=>outputs.push(markup);app.openModal=markup=>outputs.push(markup);
  app.renderSchoolList({});app.renderDeliveryList({});app.renderOpportunityList({});app.renderPersonList({});
  app.openSchoolModal(maliciousId);app.openDeliveryModal('D_CUSTOM');app.openOpportunityModal('O_CUSTOM');app.openPersonModal('P_CUSTOM');app.editStakeholder(app.data.stakeholders[0].id);
  for(const markup of outputs) {
    assert.doesNotMatch(markup,/<img\b|<script\b|onerror="globalThis/);
    assert.ok(markup.includes('&lt;img')||markup.includes('&quot;&gt;'));
  }
  assert.deepEqual(plain(app.data),original);
  let captured;
  const context={capture(value){captured=value;},decodeURIComponent};
  vm.runInNewContext('capture('+app.jsArg(maliciousId)+')',context);
  assert.equal(captured,maliciousId);assert.equal(context.pwned,undefined);
});

test('editing preserves existing custom products, stages and school types in the form',()=>{
  const {app}=load();app.data=fixture();
  app.data.schools[0].schoolType=['特殊学段'];
  app.data.deliveries[0].productTypes=['历史产品'];app.data.deliveries[0].quantities={'历史产品':8};app.data.deliveries[0].progress='历史状态';
  app.data.opportunities[0].products=['自定义产品'];app.data.opportunities[0].stage='历史阶段';
  let markup;app.openModal=value=>{markup=value;};
  app.openSchoolModal('S_CUSTOM');assert.match(markup,/name="schoolType" value="特殊学段" checked/);
  app.openDeliveryModal('D_CUSTOM');assert.match(markup,/name="productTypes" value="历史产品" checked/);assert.match(markup,/data-type="历史产品" value="8"/);assert.match(markup,/value="历史状态" selected/);
  app.openOpportunityModal('O_CUSTOM');assert.match(markup,/name="products" value="自定义产品" checked/);assert.match(markup,/value="历史阶段" selected/);
});

test('legacy owner names select their person IDs, unresolved owners remain selected and slash dates display correctly',()=>{
  const {app}=load();app.data=fixture();
  app.data.opportunities[0].salesId='张老师';app.data.opportunities[0].signDate='2026/5/22';
  let markup;app.openModal=value=>{markup=value;};
  app.openOpportunityModal('O_CUSTOM');assert.match(markup,/value="P_CUSTOM" selected>张老师/);assert.match(markup,/name="signDate"[^>]+value="2026-05-22"/);
  assert.equal(app.data.opportunities[0].signDate,'2026/5/22');
  app.data.deliveries[0].managerId='历史负责人';app.openDeliveryModal('D_CUSTOM');
  assert.match(markup,/value="历史负责人" selected>历史负责人（原记录）/);
});
