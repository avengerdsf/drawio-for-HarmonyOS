import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require=createRequire(import.meta.url);
const ts=require(typeScriptPath());
const source=fs.readFileSync(new URL('./NativeAcceptanceCleanup.ets',import.meta.url),'utf8');
const folder='file://docs/storage/Users/currentUser/Download/drawio-test-tmp';
const file=folder+'/native-open.drawio';
const other='file://docs/storage/Users/currentUser/Download/personal.drawio';
const sibling=folder+'-other/personal.drawio';
const clean=value=>JSON.parse(JSON.stringify(value));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function setup({records={},rights={},activate,revoke,flush,revokeLeavesPermission=false}={}){
 const values=new Map(Object.entries(records)),permissions=new Map(Object.entries(rights));
 const checked=[],activated=[],revoked=[],written=[];
 const prefs={getSync:(key,fallback)=>values.has(key)?values.get(key):fallback,
  putSync(key,value){written.push([key,value]);values.set(key,value);},flush:()=>flush?flush():Promise.resolve()};
 const fileShare={OperationMode:{READ_MODE:1,WRITE_MODE:2},
  checkPersistentPermission(policies){checked.push(...clean(policies));return Promise.resolve(policies.map(policy=>((permissions.get(policy.uri)||0)&policy.operationMode)===policy.operationMode));},
  activatePermission(policies){activated.push(...clean(policies));return activate?activate(policies):Promise.resolve();},
  revokePermission(policies){revoked.push(...clean(policies));return (revoke?revoke(policies):Promise.resolve()).then(()=>{if(!revokeLeavesPermission)for(const policy of policies)permissions.set(policy.uri,0);});}};
 const module={exports:{}};
 const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},reportDiagnostics:true});
 assert.deepEqual(output.diagnostics.filter(item=>item.category===ts.DiagnosticCategory.Error),[]);
 vm.runInNewContext(output.outputText,{module,exports:module.exports,require:name=>{
  if(name==='@kit.CoreFileKit')return {fileShare,fileUri:{FileUri:class{constructor(uri){this.path=decodeURIComponent(uri.slice('file://docs'.length));}}}};
  if(name==='@ohos.data.preferences')return {default:{getPreferencesSync:()=>prefs}};
  throw Error('Unsupported runtime dependency: '+name);
 }});
 return {tool:module.exports.default,values,permissions,checked,activated,revoked,written};
}

test('invalid caller basenames fail before preferences or permission operations',async()=>{
 for(const name of ['', '  ', '.', '..', '../outside', 'child/file', 'child\\file', 'bad\0name']){
  const run=setup({rights:{[folder]:3}}),before=[...run.values];
  const result=await run.tool.prepare({},[name]);
  assert.equal(result.success,false,name);assert.equal(result.readyForNode,false,name);
  assert.equal(result.filesystemModified,false);assert.equal(run.checked.length,0);assert.equal(run.activated.length,0);
  assert.deepEqual([...run.values],before);assert.ok(result.failures.length);
 }
});

test('the real ledger backup basename is encoded as one URI path segment and duplicate names are harmless',async()=>{
 const name='.$native-open.drawio.bkp',uri=folder+'/'+encodeURIComponent(name);
 const run=setup({rights:{[folder]:3,[uri]:3}});
 const result=await run.tool.prepare({},[name,name]);
 assert.equal(result.readyForNode,true);assert.equal(result.success,true);
 assert.deepEqual(clean(result.expectedNames),[name]);assert.ok(run.activated.some(policy=>policy.uri===uri));
 assert.equal(run.written.length,0);assert.equal(run.revoked.length,0);
});

test('prepare only activates existing exact-scope RW/READ policies and does not manufacture grants',async()=>{
 const run=setup({records:{persistedFileUris:JSON.stringify([file,other,sibling])},rights:{[folder]:3,[file]:1,[other]:3,[sibling]:3}});
 const result=await run.tool.prepare({},['native-open.drawio','missing.pdf']);
 assert.equal(result.readyForNode,true);assert.equal(result.success,true);
 assert.deepEqual(run.activated,[{uri:folder,operationMode:3},{uri:file,operationMode:1}]);
 assert.ok(!run.checked.some(policy=>policy.uri===other||policy.uri===sibling));
 assert.equal(run.written.length,0);assert.equal(result.filesystemModified,false);
});

test('READ-only folder never authorizes the destructive Node phase',async()=>{
 const run=setup({rights:{[folder]:1,[file]:3}});
 const result=await run.tool.prepare({},['native-open.drawio']);
 assert.equal(result.readyForNode,false);assert.equal(result.success,false);
 assert.deepEqual(run.activated,[{uri:folder,operationMode:1},{uri:file,operationMode:3}]);
});

test('an activation error is reported without claiming that policy was activated',async()=>{
 const run=setup({rights:{[folder]:3},activate:()=>Promise.reject({code:13900001,message:'denied',data:[{code:2}]})});
 const result=await run.tool.prepare({},[]);
 assert.equal(result.success,false);assert.equal(result.readyForNode,false);
 assert.equal(result.policies[0].activated,false);assert.equal(result.failures[0].code,13900001);
 assert.deepEqual(clean(result.failures[0].policyErrorCodes),[2]);
});

test('encoded parent traversal in a stored owned-looking URI is never activated or revoked',async()=>{
 const escape=folder+'/%2e%2e/private.drawio';
 const run=setup({records:{persistedFileUris:JSON.stringify([escape,other])},rights:{[folder]:3,[escape]:3}});
 const ready=await run.tool.prepare({},[]);
 assert.equal(ready.success,false);assert.ok(ready.failures.some(error=>error.uri===escape));
 const done=await run.tool.finalize({});
 assert.equal(done.success,false);assert.ok(!run.checked.some(policy=>policy.uri===escape));
 assert.ok(!run.activated.some(policy=>policy.uri===escape));assert.ok(!run.revoked.some(policy=>policy.uri===escape));
 assert.deepEqual(JSON.parse(run.values.get('persistedFileUris')),[other]);
});

test('finalize revokes only owned policies in their checked mode and filters exact URI boundaries',async()=>{
 const run=setup({records:{persistedFileUris:JSON.stringify([folder,file,other,sibling]),defaultDownloadUri:JSON.stringify([folder,other]),theme:'keep'},
  rights:{[folder]:3,[file]:1,[other]:3,[sibling]:3}});
 await run.tool.prepare({},['native-open.drawio']);
 const result=await run.tool.finalize({});
 assert.equal(result.success,true);assert.equal(result.preferencesFlushed,true);assert.equal(result.filesystemModified,false);
 assert.deepEqual(run.revoked,[{uri:folder,operationMode:3},{uri:file,operationMode:1}]);
 assert.deepEqual(JSON.parse(run.values.get('persistedFileUris')),[other,sibling]);
 assert.deepEqual(JSON.parse(run.values.get('defaultDownloadUri')),[other]);assert.equal(run.values.get('theme'),'keep');
 assert.ok(result.policies.every(policy=>policy.cleared));
});

test('revoke failure stays false while preference filtering and other policy revocations proceed',async()=>{
 const run=setup({records:{persistedFileUris:JSON.stringify([folder,file,other])},rights:{[folder]:3,[file]:1},
  revoke:policies=>policies[0].uri===folder?Promise.reject({code:801,message:'unavailable'}):Promise.resolve()});
 const result=await run.tool.finalize({});
 assert.equal(result.success,false);assert.equal(result.preferencesFlushed,true);
 assert.ok(result.failures.some(error=>error.phase==='revoke'&&error.code===801));
 assert.deepEqual(JSON.parse(run.values.get('persistedFileUris')),[other]);
 assert.equal(result.policies.find(policy=>policy.uri===folder).revoked,false);
 assert.equal(result.policies.find(policy=>policy.uri===file).revoked,true);
});

test('a policy reported still persisted after revoke is not marked cleared',async()=>{
 const run=setup({rights:{[folder]:3},revokeLeavesPermission:true});
 const result=await run.tool.finalize({});
 assert.equal(result.success,false);assert.equal(result.policies[0].revoked,true);assert.equal(result.policies[0].cleared,false);
});

test('finalize keeps newly added unrelated records and waits for the durable flush',async()=>{
 let release;const disk=new Promise(resolve=>{release=resolve;});let run;
 const added='file://docs/storage/Users/currentUser/Documents/new.drawio';
 run=setup({records:{persistedFileUris:JSON.stringify([folder])},rights:{[folder]:3},
  revoke:()=>{run.values.set('persistedFileUris',JSON.stringify([folder,added]));return Promise.resolve();},flush:()=>disk});
 let completed=false;const pending=run.tool.finalize({}).then(result=>{completed=true;return result;});
 await tick();assert.equal(completed,false);assert.deepEqual(JSON.parse(run.values.get('persistedFileUris')),[added]);
 release();const result=await pending;assert.equal(result.success,true);assert.equal(result.preferencesFlushed,true);
});

test('malformed preferences are preserved and block preparation',async()=>{
 for(const value of ['not json','{}','[1]']){
  const run=setup({records:{persistedFileUris:value},rights:{[folder]:3}});
  const result=await run.tool.prepare({},[]);
  assert.equal(result.success,false);assert.equal(result.readyForNode,false);assert.equal(run.checked.length,0);
  assert.equal(run.values.get('persistedFileUris'),value);assert.equal(run.written.length,0);
 }
});

test('this temporary ArkTS stage contains no filesystem deletion API or production bootstrap reference',()=>{
 assert.doesNotMatch(source,/\bfs\.|unlink\(|rmdir\(|@ohos\.file\.fs/);
 const bootstrap=fs.readFileSync(new URL('../harmony-electron/web_engine/src/main/resources/resfile/resources/app/bootstrap.mjs',import.meta.url),'utf8');
 assert.ok(!bootstrap.includes('NativeAcceptanceCleanup'));
});
