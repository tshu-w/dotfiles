const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../antigravity/usage.ts'),'utf8'))
  .replace(/import\s+\{([^}]+)\}\s+from\s+"([^"]+)";/g,'const {$1}=require("$2");').replace(/^export /gm,'');
const ID='11111111-1111-4111-8111-111111111111';
const profile='/fixture/antigravity-cli',file=profile+'/conversations/'+ID+'.db';
const error=/^Antigravity native usage unavailable$/;
const unknown=fn=>assert.throws(fn,e=>error.test(e.message));
function varint(value){let n=BigInt(value),b=[];do{let v=Number(n&127n);n>>=7n;b.push(v|(n?128:0));}while(n);return Buffer.from(b);}
function field(tag,value){if(typeof value==='number'||typeof value==='bigint')return Buffer.concat([varint(tag*8),varint(value)]);const b=Buffer.isBuffer(value)?value:Buffer.from(value);return Buffer.concat([varint(tag*8+2),varint(b.length),b]);}
const blob=(...fields)=>Buffer.concat(fields);
function gen(idx,input=2984,cacheRead=0,output=71,options={}){
  const usage=blob(field(2,input),field(3,output),...(options.omitRead?[]:[field(5,cacheRead)]),field(4,options.cacheWrite??0),...(options.extra??[]));
  return {idx,data:blob(field(1,options.missingUsage?Buffer.alloc(0):field(4,usage)),...(options.packed?[field(2,blob(...(options.steps??[1,2]).map(varint))) ]:(options.steps??[1,2]).map(i=>field(2,i))))};
}
function tools(options={}){
  const args=options.args??{fixtureVersion:1,toolSummary:'synthetic description'};
  const call=blob(field(1,options.id??'native-call'),field(2,options.name??'mcp_pi_fixture'),field(3,JSON.stringify(args)));
  const other=options.otherArgs?blob(field(1,options.id??'native-call'),field(2,options.name??'mcp_pi_fixture'),field(3,JSON.stringify(options.otherArgs))):call;
  return [
    {idx:1,step_type:15,metadata:Buffer.alloc(0),step_payload:blob(field(1,15),field(20,blob(field(7,call),...(options.duplicateCall?[field(7,call)]:[]))))},
    {idx:2,step_type:132,metadata:blob(field(4,other),...(options.modified?[field(29,other)]:[])),step_payload:blob(field(1,132),field(140,Buffer.alloc(0)))},
  ];
}
function fixture(options={}){
  const state={generations:[],steps:[],ino:7,sidecars:new Map(),opened:0,closed:0,sql:[],...options.state};
  const stat=p=>{
    const side=['-wal','-shm','-journal'].find(s=>p===file+s);
    if(side&&!state.sidecars.has(side)){const e=Error('absent');e.code='ENOENT';throw e;}
    if(![profile,profile+'/conversations',file].includes(p)&&!side)throw Error('unexpected path');
    const overrides=side?state.sidecars.get(side):p===file?options.databaseStat??{}:{};
    return {uid:501,nlink:1,dev:1,ino:p===file?state.ino:2,isFile:()=>p===file||!!side,isDirectory:()=>p!==file&&!side,...overrides};
  };
  class Database {
    constructor(p,flags){assert.equal(p,file);assert.equal(flags.readOnly,true);state.opened++;this.isTransaction=false;}
    exec(sql){state.sql.push(sql);assert.ok(['BEGIN','ROLLBACK','PRAGMA busy_timeout=0'].includes(sql));
      if(options.busy&&sql==='BEGIN')throw Object.assign(Error('database busy'),{errcode:5});
      if(sql==='BEGIN')this.isTransaction=true;if(sql==='ROLLBACK')this.isTransaction=false;
    }
    prepare(sql){state.sql.push(sql);return {
      all:(lower)=>{
        if(sql==='SELECT cascade_id FROM trajectory_meta'){options.onSnapshot?.(state);return [{cascade_id:options.wrongSession?'other':ID}];}
        if(sql==='SELECT idx FROM gen_metadata WHERE idx>? ORDER BY idx')return state.generations.filter(r=>r.idx>lower).map(r=>({idx:r.idx}));
        if(sql==='SELECT idx FROM steps WHERE idx>? ORDER BY idx')return state.steps.filter(r=>r.idx>lower).map(r=>({idx:r.idx}));
        throw Error('unexpected all');
      },
      get:(idx)=>{
        if(sql==='SELECT MAX(idx) AS idx FROM gen_metadata')return {idx:state.generations.length?Math.max(...state.generations.map(r=>r.idx)):null};
        if(sql==='SELECT MAX(idx) AS idx FROM steps')return {idx:state.steps.length?Math.max(...state.steps.map(r=>r.idx)):null};
        options.onData?.(state);
        if(sql==='SELECT data FROM gen_metadata WHERE idx=?')return state.generations.find(r=>r.idx===idx);
        if(sql==='SELECT step_type,metadata,step_payload FROM steps WHERE idx=?')return state.steps.find(r=>r.idx===idx);
        throw Error('unexpected get');
      },
    };}
    close(){state.closed++;if(state.closeFailure){state.closeFailure=false;throw Error('synthetic close failure');}}
  }
  const modules={'node:fs':{lstatSync:stat,realpathSync:p=>options.alias&&p===file?'/aliased':p},'node:path':path,'node:sqlite':{DatabaseSync:Database}};
  const module={exports:{}};
  vm.runInNewContext(source+'\nmodule.exports={createNativeUsageReader};',{module,Buffer,Uint8Array,process:{getuid:()=>501},require:name=>{assert.ok(name in modules);return modules[name];}});
  return {state,make:()=>module.exports.createNativeUsageReader(profile,ID)};
}
function started(options={}){const f=fixture(options),reader=f.make();reader.beginPrompt();return {...f,reader};}
function seed(f,options={}){f.state.generations=[gen(0,2984,0,71,{omitRead:true,...options})];f.state.steps=tools();}

test('real SQLite interface reads owned synthetic WAL data across prompt, tool and completion',async t=>{
  const {DatabaseSync}=require('node:sqlite');
  const {createNativeUsageReader}=await import('../antigravity/usage.ts');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(),'pi-agy-usage-sqlite-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const ownedProfile=path.join(root,'antigravity-cli'),conversations=path.join(ownedProfile,'conversations');
  fs.mkdirSync(conversations,{recursive:true,mode:0o700});
  const ownedFile=path.join(conversations,ID+'.db'),db=new DatabaseSync(ownedFile);
  try{
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE trajectory_meta(cascade_id TEXT);
      CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB);
      CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,metadata BLOB,step_payload BLOB);`);
    db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(ID);
    const reader=createNativeUsageReader(ownedProfile,ID);
    reader.beginPrompt();
    unknown(()=>reader.readCompletion(3055));
    const first=gen(0,2984,0,71,{omitRead:true,packed:true});
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(first.idx,first.data);
    const insert=db.prepare('INSERT INTO steps VALUES (?,?,?,?)');
    for(const step of tools())insert.run(step.idx,step.step_type,step.metadata,step.step_payload);
    assert.ok(fs.existsSync(ownedFile+'-wal'));assert.ok(fs.existsSync(ownedFile+'-shm'));
    const tool=reader.readTool('fixture',{fixtureVersion:1},false);
    assert.equal(tool.generationIndex,0);assert.equal(tool.input,2984);assert.equal(tool.cacheRead,0);assert.equal(tool.totalTokens,3055);
    const last=gen(1,2214,935,10,{steps:[3]});
    db.prepare('INSERT INTO gen_metadata VALUES (?,?)').run(last.idx,last.data);
    const completed=reader.readCompletion(3159);
    assert.equal(completed.input,2214);assert.equal(completed.output,10);assert.equal(completed.cacheRead,935);
    assert.equal(completed.totalTokens,3159);assert.deepEqual(completed.generations.map(row=>row.index),[0,1]);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(reader.readCompletion(3159).totalTokens,3159);
    reader.beginPrompt();unknown(()=>reader.readCompletion(3159));
  }finally{db.close();}
});

test('native first tool and final generation counters stay distinct from cumulative ACP usage',()=>{
  const f=started();seed(f);
  const tool=f.reader.readTool('fixture',{fixtureVersion:1},false);
  assert.equal(tool.generationIndex,0);assert.equal(tool.input,2984);assert.equal(tool.cacheRead,0);assert.equal(tool.output,71);assert.equal(tool.totalTokens,3055);
  f.state.generations.push(gen(1,2214,935,10,{steps:[3]}));
  const final=f.reader.readCompletion(3159);
  assert.equal(final.generationIndex,1);assert.equal(final.input,2214);assert.equal(final.cacheRead,935);assert.equal(final.totalTokens-final.cacheRead,2224);
  assert.equal(final.generations.length,2);assert.equal(final.generations.reduce((n,g)=>n+g.input,0),5198);assert.equal(final.generations.reduce((n,g)=>n+g.output,0),81);
  assert.equal(f.state.opened,3);assert.equal(f.state.closed,3);
});
test('packed generation step indices bind without decoding unrelated transcript text',()=>{
  const f=started();seed(f,{packed:true});assert.equal(f.reader.readTool('fixture',{fixtureVersion:1},false).generationIndex,0);
});
test('native output already includes thought tokens',()=>{
  const f=started();seed(f,{extra:[field(9,3),field(10,7)]});f.state.generations=[gen(0,10101,1010,10,{extra:[field(9,3),field(10,7)]})];
  assert.equal(f.reader.readTool('fixture',{fixtureVersion:1},false).totalTokens,11121);
});
test('typed nested parameters compare independent of object key order',()=>{
  const f=started();seed(f);f.state.steps=tools({args:{toolSummary:'native',nested:{b:[1,true,null],a:'x'}}});
  assert.equal(f.reader.readTool('fixture',{nested:{a:'x',b:[1,true,null]}},false).generationIndex,0);
  unknown(()=>f.reader.readTool('fixture',{nested:{a:'x',b:['1',true,null]}},false));
});
test('declared toolSummary is retained and must match',()=>{
  const f=started();seed(f);
  assert.equal(f.reader.readTool('fixture',{fixtureVersion:1,toolSummary:'synthetic description'},true).generationIndex,0);
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},true));
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1,toolSummary:'other'},true));
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1,toolSummary:'synthetic description'},false));
});
for(const variant of ['duplicate_call','duplicate_generic','modified','wrong_native_id','different_raw_args','wrong_name','shared_generation'])test('ambiguous or modified tool binding refuses '+variant,()=>{
  const f=started();seed(f);
  if(variant==='duplicate_call')f.state.steps=tools({duplicateCall:true});
  if(variant==='duplicate_generic')f.state.steps.push({...f.state.steps[1],idx:3});
  if(variant==='modified')f.state.steps=tools({modified:true});
  if(variant==='wrong_native_id')f.state.steps[1]=tools({id:'different'})[1];
  if(variant==='different_raw_args')f.state.steps=tools({otherArgs:{fixtureVersion:1,toolSummary:'changed'}});
  if(variant==='wrong_name')f.state.steps=tools({name:'mcp_pi_other'});
  if(variant==='shared_generation')f.state.generations.push(gen(1));
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
});
test('a consumed native call cannot be reused by another callback',()=>{
  const f=started();seed(f);
  assert.equal(f.reader.readTool('fixture',{fixtureVersion:1},false).generationIndex,0);
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
  f.state.steps.push(...tools({id:'new-native-call'}).map(step=>({...step,idx:step.idx+2})));
  f.state.generations=[gen(0,2984,0,71,{steps:[1,2,3,4]})];
  assert.equal(f.reader.readTool('fixture',{fixtureVersion:1},false).generations.length,1);
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
});
test('an extra generic step cannot allocate an already consumed native call again',()=>{
  const f=started();seed(f);
  f.reader.readTool('fixture',{fixtureVersion:1},false);
  f.state.steps.push({...f.state.steps[1],idx:3});
  f.state.generations=[gen(0,2984,0,71,{steps:[1,2,3]})];
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
});
test('a consumed native ID remains unavailable even under a different step pair',()=>{
  const f=started();seed(f);
  f.reader.readTool('fixture',{fixtureVersion:1},false);
  f.state.steps=tools().map(step=>({...step,idx:step.idx+2}));
  f.state.generations=[gen(0,2984,0,71,{steps:[3,4]})];
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
});
test('distinct calls with different arguments in one generation are each consumed once',()=>{
  const f=started();seed(f);
  f.state.steps.push(...tools({id:'second-call',args:{fixtureVersion:2,toolSummary:'native'}}).map(step=>({...step,idx:step.idx+2})));
  f.state.generations=[gen(0,2984,0,71,{steps:[1,2,3,4]})];
  const first=f.reader.readTool('fixture',{fixtureVersion:1},false),second=f.reader.readTool('fixture',{fixtureVersion:2},false);
  assert.equal(first.generationIndex,second.generationIndex);assert.equal(second.generations.length,1);
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:2},false));
});
test('two unconsumed same-argument native calls remain ambiguous',()=>{
  const f=started();seed(f);
  f.state.steps.push(...tools({id:'second-call'}).map(step=>({...step,idx:step.idx+2})));
  f.state.generations=[gen(0,2984,0,71,{steps:[1,2,3,4]})];
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
});
test('call consumption occurs only after successful transaction cleanup',()=>{
  const f=started();seed(f);f.state.closeFailure=true;
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
  assert.equal(f.reader.readTool('fixture',{fixtureVersion:1},false).generationIndex,0);
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
});
test('empty outer usage placeholder cannot publish zero tool occupancy',()=>{
  const f=started();seed(f);
  f.state.generations[0].data=blob(field(1,field(4,Buffer.alloc(0))),field(2,1),field(2,2));
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
});
test('completion requires unique arithmetic candidate and that candidate must be latest',()=>{
  const f=started();seed(f);f.state.generations.push(gen(1,2214,935,10));
  unknown(()=>f.reader.readCompletion(3055));unknown(()=>f.reader.readCompletion(999));
  f.state.generations[1]=gen(1,2110,935,10);unknown(()=>f.reader.readCompletion(3055));
});
test('prompt baseline excludes old rows and cannot reuse a previous prompt measurement',()=>{
  const f=fixture();f.state.generations=[gen(0)];f.state.steps=tools();const r=f.make();r.beginPrompt();unknown(()=>r.readCompletion(3055));
  f.state.generations.push(gen(1,2214,935,10));assert.equal(r.readCompletion(3159).generations.length,1);
  r.beginPrompt();unknown(()=>r.readCompletion(3159));
});
test('read without successful beginPrompt and empty fresh records are unavailable',()=>{
  const f=fixture(),r=f.make();unknown(()=>r.readCompletion(0));r.beginPrompt();unknown(()=>r.readCompletion(0));
});
for(const variant of ['missing_outer','unsafe_integer','duplicate_scalar','cache_write','malformed'])test('unsafe or missing usage refuses '+variant,()=>{
  const f=started();seed(f);
  if(variant==='missing_outer')f.state.generations=[gen(0,1,0,1,{missingUsage:true})];
  if(variant==='unsafe_integer')f.state.generations=[gen(0,9007199254740992n)];
  if(variant==='duplicate_scalar')f.state.generations=[gen(0,1,0,1,{extra:[field(5,0)]})];
  if(variant==='cache_write')f.state.generations=[gen(0,1,0,1,{cacheWrite:1})];
  if(variant==='malformed')f.state.generations[0].data=Buffer.from([10,255]);
  unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
});
test('long single prompt retains all fresh generations and steps beyond probe limits',()=>{
  const f=started();
  f.state.generations=Array.from({length:33},(_,i)=>gen(i,100+i,0,1,{steps:i===32?[64,65]:[]}));
  f.state.steps=Array.from({length:64},(_,idx)=>({idx,step_type:14,metadata:Buffer.alloc(0),step_payload:Buffer.alloc(0)}));
  f.state.steps.push(...tools().map((step,i)=>({...step,idx:64+i})));
  const tool=f.reader.readTool('fixture',{fixtureVersion:1},false);
  assert.equal(tool.generationIndex,32);assert.equal(tool.generations.length,33);assert.equal(tool.totalTokens,133);
  assert.equal(f.reader.readCompletion(133).generations.length,33);
});
test('fresh latest generation without usage never falls back to an older tool row',()=>{
  const f=started();seed(f);f.state.generations.push(gen(1,1,0,1,{missingUsage:true}));unknown(()=>f.reader.readTool('fixture',{fixtureVersion:1},false));
});
for(const variant of ['foreign_uid','hardlink','symlink','alias'])test('database identity admission refuses '+variant,()=>{
  const f=fixture({databaseStat:variant==='foreign_uid'?{uid:0}:variant==='hardlink'?{nlink:2}:variant==='symlink'?{isFile:()=>false}:{},alias:variant==='alias'});
  unknown(f.make);assert.equal(f.state.opened,0);
});
test('database replacement before and inside transaction is rejected',()=>{
  const f=started();seed(f);f.state.ino++;unknown(()=>f.reader.readCompletion(3055));
  const g=fixture({onSnapshot(state){state.ino++;}});unknown(()=>g.make().beginPrompt());assert.equal(g.state.closed,1);
  const h=started({onData(state){state.ino++;}});seed(h);unknown(()=>h.reader.readCompletion(3055));
});
for(const suffix of ['-wal','-shm','-journal'])test('unsafe live sidecar rejected '+suffix,()=>{
  const f=fixture();f.state.sidecars.set(suffix,{nlink:2});unknown(f.make);
});
test('legal sidecar disappearance and replacement do not invalidate a pinned database',()=>{
  const f=fixture({onSnapshot(state){state.sidecars.clear();state.sidecars.set('-shm',{ino:99});}});f.state.sidecars.set('-wal',{ino:1});
  const r=f.make();r.beginPrompt();f.state.generations=[gen(0)];f.state.sidecars.set('-wal',{ino:200});assert.equal(r.readCompletion(3055).totalTokens,3055);
});
test('busy database is attempted once, closed and returned as fixed unknown',()=>{
  const f=fixture({busy:true});const r=f.make();unknown(()=>r.beginPrompt());assert.equal(f.state.opened,1);assert.equal(f.state.closed,1);
});
test('trajectory cascade must match the one owned session',()=>{
  const f=fixture({wrongSession:true});unknown(()=>f.make().beginPrompt());assert.equal(f.state.closed,1);
});
