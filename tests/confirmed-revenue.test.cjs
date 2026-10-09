const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', '浙江民办校作战地图.html'), 'utf8');
const source = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes('const app = {'));
const plain = value => JSON.parse(JSON.stringify(value));
const school = (id,city) => ({id,name:id,city,district:'',schoolType:['初中'],principal:'',principalTitle:'',phone:'',totalAmount:0});
const delivery = (id,schoolId,confirmedRevenue,progress='部署中') => ({id,schoolId,name:id,confirmedRevenue,progress,productTypes:['批阅机'],quantities:{批阅机:1},deployLocation:'',managerId:'',planDate:'',actualDate:'',remark:''});

function load() {
  const elements = new Map([['contextMenu',{addEventListener(){}}]]);
  const storage = new Map();
  let chartOption,downloaded,toasts=[];
  const context = vm.createContext({
    document:{addEventListener(){},getElementById(id){return elements.get(id)||null;}},
    window:{addEventListener(){}},setTimeout(){},console,
    localStorage:{setItem(key,value){storage.set(key,value);},getItem(key){return storage.get(key)||null;}},
    FormData:class{constructor(form){this.form=form;}get(key){return this.form.fields[key]??null;}},
    FileReader:class{readAsText(file){this.onload({target:{result:file.content}});}},
    echarts:{registerMap(){},init(){return {setOption(option){chartOption=option;},on(){},resize(){}};}}
  });
  vm.runInContext(source+'\nglobalThis.app=app;',context);
  const app=context.app;
  app.data={schools:[school('S1','杭州市'),school('S2','金华市')],deliveries:[],opportunities:[],persons:[],stakeholders:[],logs:[]};
  app.toast=(message,type)=>toasts.push({message,type});app.closeModal=()=>{};app.refreshPage=()=>{};
  app.downloadFile=content=>{downloaded=content;};
  return {app,elements,storage,chartOption:()=>chartOption,downloaded:()=>downloaded,toasts:()=>toasts};
}

test('income aggregation includes completed deliveries, keeps decimal precision, and separates missing from recorded zero',()=>{
  const {app}=load();
  app.data.deliveries=[delivery('D1','S1',0.1),delivery('D2','S1',0.2,'已完成'),delivery('D3','S1',0),delivery('D4','S1',null),delivery('D5','S1',''),delivery('D6','S2','12.4986789')];
  delete app.data.deliveries[4].confirmedRevenue;
  const province=app.computeProvinceStats();
  const cities=app.computeCityStats();
  assert.equal(province.confirmedRevenue,12.7986789);
  assert.equal(province.confirmedRevenueRecordedCount,4);
  assert.equal(province.confirmedRevenueMissingCount,2);
  const hangzhou=cities.find(city=>city.name==='杭州市');
  assert.equal(hangzhou.confirmedRevenue,0.3);
  assert.equal(hangzhou.deliveryCount,4);
  assert.equal(hangzhou.confirmedRevenueRecordedCount,3);
  assert.equal(hangzhou.confirmedRevenueMissingCount,2);
  assert.equal(cities.find(city=>city.name==='金华市').confirmedRevenue,12.4986789);
  assert.equal(app.formatConfirmedRevenue(0),'0万');
  for(const value of [null,undefined,'',' ',false,NaN,Infinity,-1,'not a number']) assert.equal(app.formatConfirmedRevenue(value),'未录入');
  assert.equal(app.formatAmount(app.sumAmounts([2635,237.95])),'2872.95');
  assert.equal(app.formatAmount(0.0000001),'0.0000001');
  assert.equal(app.sumAmounts([0.0000001,0.0000002]),0.0000003);
});

test('home, map tooltip, city statistics, delivery list, school cards and edit form display income',()=>{
  const {app,elements,chartOption}=load();app.data.deliveries=[delivery('D1','S1',12.4986,'已完成'),delivery('D2','S1',null)];
  const container={innerHTML:''};app.renderHome(container);
  assert.match(container.innerHTML,/已确认收入金额/);assert.match(container.innerHTML,/12\.4986万/);assert.match(container.innerHTML,/已录入 1\/2 项 · 未录入 1 项/);
  app.renderCityDetail(container,'杭州市');assert.match(container.innerHTML,/已确认收入金额/);assert.match(container.innerHTML,/12\.4986万/);
  elements.set('mapContainer',{addEventListener(){}});app.renderMap();
  const option=chartOption(),city=option.series[0].data.find(city=>city.name==='杭州市');
  const tooltip=option.tooltip.formatter({name:'杭州市',data:city});
  assert.match(tooltip,/已确认收入金额: <b>12\.4986万/);assert.match(tooltip,/未录入 1 项/);
  app.applyListMarkup=(_container,_type,markup)=>{container.innerHTML=markup;};
  app.renderDeliveryList(container);assert.match(container.innerHTML,/已确认收入金额（万元）/);assert.match(container.innerHTML,/12\.4986/);assert.match(container.innerHTML,/未录入/);
  assert.match(app.deliveryCard(app.data.deliveries[0]),/已确认收入金额: 12\.4986万/);
  assert.match(app.deliveryCard(app.data.deliveries[1]),/已确认收入金额: 未录入/);
  app.openModal=markup=>{container.innerHTML=markup;};app.openDeliveryModal('D1');
  assert.match(container.innerHTML,/name="confirmedRevenue"[^>]+value="12\.4986"/);
  app.openDeliveryModal('D2');assert.match(container.innerHTML,/name="confirmedRevenue"[^>]+value=""/);
  app.data.deliveries[1].confirmedRevenue=0;app.openDeliveryModal('D2');assert.match(container.innerHTML,/name="confirmedRevenue"[^>]+value="0"/);
});

test('delivery saving persists zero and empty distinctly, validates invalid amounts, and preserves unrelated fields',()=>{
  const {app,elements,storage,toasts}=load();
  const original=delivery('D1','S1',12.4986);original.legacyReference='keep this';app.data.deliveries=[original];
  original.quantities={批阅机:2.5};
  const quantity={value:'2.5',dataset:{type:'批阅机'},closest(){return {classList:{contains(){return false;}}};}};
  const form={fields:{...original,confirmedRevenue:'0'},reportValidity(){return true;},querySelectorAll(selector){return selector==='.qty-input'?[quantity]:[{value:'批阅机'}];}};
  elements.set('deliveryForm',form);app.saveDelivery('D1');
  assert.equal(app.data.deliveries[0].confirmedRevenue,0);assert.equal(app.data.deliveries[0].legacyReference,'keep this');
  assert.deepEqual(plain(app.data.deliveries[0].quantities),{批阅机:2.5});
  assert.equal(JSON.parse(storage.get('zhejiang_private_school_battle_map')).deliveries[0].confirmedRevenue,0);
  form.fields.confirmedRevenue='';app.saveDelivery('D1');assert.equal(app.data.deliveries[0].confirmedRevenue,null);
  form.fields.confirmedRevenue='12.4986789';app.saveDelivery('D1');assert.equal(app.data.deliveries[0].confirmedRevenue,12.4986789);
  form.fields.confirmedRevenue='-1';app.saveDelivery('D1');assert.equal(app.data.deliveries[0].confirmedRevenue,12.4986789);assert.equal(toasts().at(-1).type,'error');
  form.fields.confirmedRevenue='1e-7';app.saveDelivery('D1');assert.equal(app.data.deliveries[0].confirmedRevenue,0.0000001);
});

test('CSV round trip preserves decimals, recorded zero and blank income; older CSV keeps existing income',()=>{
  const {app,elements,downloaded}=load();
  app.data.deliveries=[delivery('D1','S1',12.4986789),delivery('D2','S1',0),delivery('D3','S1',null),delivery('D4','S2',0.0000001)];
  elements.set('importType',{value:'deliveries'});const result={classList:{remove(){}},textContent:''};elements.set('importResult',result);
  const upload=text=>{elements.set('importFile',{files:[{content:text}]});app.importCSV();assert.match(result.textContent,/失败 0 条/);};
  const before=plain(app.data.deliveries);app.exportCSV('deliveries');upload(downloaded());assert.deepEqual(plain(app.data.deliveries),before);
  const rows=app.parseCSV(downloaded());const incomeIndex=rows[0].values.indexOf('已确认收入金额');
  const oldText=rows.map(row=>row.values.filter((_,index)=>index!==incomeIndex).map(value=>app.csvField(value)).join(',')).join('\r\n');
  app.data.deliveries[0].confirmedRevenue=99.1234;upload(oldText);assert.equal(app.data.deliveries[0].confirmedRevenue,99.1234);
  app.data.deliveries=[];upload(oldText);assert.equal(app.data.deliveries[0].confirmedRevenue,null);
});

test('JSON backup retains confirmed income and old records without that field still display as unrecorded',()=>{
  const {app,downloaded}=load();app.data.deliveries=[delivery('D1','S1',0),delivery('D2','S2',12.4986)];
  delete app.data.deliveries[1].confirmedRevenue;
  app.exportAllData();const backup=JSON.parse(downloaded());
  assert.equal(backup.deliveries[0].confirmedRevenue,0);
  assert.equal(Object.hasOwn(backup.deliveries[1],'confirmedRevenue'),false);
  assert.equal(app.formatConfirmedRevenue(backup.deliveries[1].confirmedRevenue),'未录入');
});
