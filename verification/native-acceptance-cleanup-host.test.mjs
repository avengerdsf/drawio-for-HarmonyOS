import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const require=createRequire(import.meta.url);
const ts=require(typeScriptPath());
const source=fs.readFileSync(new URL('./native-acceptance-cleanup-host.mjs',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const root='/storage/Users/currentUser/Download/drawio-test-tmp';
const editor='file:///installed/upstream/drawio/src/main/webapp/index.html';
const expected=['native-open.drawio','.$native-open.drawio.bkp','native-system-print.pdf','native-system-print-range.pdf'];
const temp=path.resolve(new URL('../tmp/',import.meta.url).pathname.replace(/^\/([A-Za-z]:\/)/,'$1'));

function cleanupTree(directory){
 const absolute=path.resolve(directory);
 assert.ok(absolute.startsWith(temp+path.sep));assert.ok(!fs.lstatSync(absolute).isSymbolicLink());
 for(const entry of fs.readdirSync(absolute)){const full=path.join(absolute,entry),stat=fs.lstatSync(full);assert.ok(!stat.isSymbolicLink());if(stat.isDirectory())cleanupTree(full);else fs.unlinkSync(full);}
 fs.rmdirSync(absolute);
}

function setup(t,{recursiveProbe=false,unexpectedAfterProbe=false,unexpectedAfterDelete=false,symlink}={}){
 fs.mkdirSync(temp,{recursive:true});
 const caseRoot=fs.mkdtempSync(path.join(temp,'cleanup-host-test-')),owned=path.join(caseRoot,'owned');
 fs.mkdirSync(owned);for(const name of expected)fs.writeFileSync(path.join(owned,name),'owned '+name);
 fs.writeFileSync(path.join(caseRoot,'outside.keep'),'outside');
 t.after(()=>cleanupTree(caseRoot));
 const calls=[],unlinked=[];let injectedAfterDelete=false;
 function map(logical){assert.ok(logical===root||logical.startsWith(root+'/'),'Filesystem access escaped fixed owned scope: '+logical);return logical===root?owned:path.join(owned,...logical.slice(root.length+1).split('/'));}
 const adapter={
  lstatSync(logical,options){calls.push(['lstat',logical]);const stat=fs.lstatSync(map(logical),options);
   if(symlink==='root'&&logical===root||symlink==='entry'&&logical===root+'/'+expected[0])return {...stat,isDirectory:()=>stat.isDirectory(),isFile:()=>stat.isFile(),isSymbolicLink:()=>true};return stat;},
  readdirSync(logical){calls.push(['readdir',logical]);return fs.readdirSync(map(logical));},
  mkdirSync(logical,options){calls.push(['mkdir',logical]);return fs.mkdirSync(map(logical),options);},
  writeFileSync(logical,data,options){calls.push(['write',logical]);return fs.writeFileSync(map(logical),data,options);},
  unlinkSync(logical){calls.push(['unlink',logical]);unlinked.push(logical);fs.unlinkSync(map(logical));
   if(unexpectedAfterDelete&&!injectedAfterDelete&&expected.some(name=>logical===root+'/'+name)){injectedAfterDelete=true;fs.writeFileSync(path.join(owned,'unexpected.keep'),'preserve');}},
  rmdirSync(logical){calls.push(['rmdir',logical]);const probe=logical.startsWith(root+'/.native-cleanup-probe-');
   if(recursiveProbe&&probe){for(const name of fs.readdirSync(map(logical))){assert.equal(name,'owned-sentinel.txt');fs.unlinkSync(path.join(map(logical),name));}fs.rmdirSync(map(logical));return;}
   fs.rmdirSync(map(logical));if(unexpectedAfterProbe&&probe)fs.writeFileSync(path.join(owned,'unexpected.keep'),'preserve');}
 };
 const module={exports:{}};
 vm.runInNewContext(compiled,{module,exports:module.exports,require:name=>{
  if(name==='node:fs')return {default:adapter};if(name==='node:path')return {default:path.posix};if(name==='node:crypto')return {randomUUID};throw Error(name);
 }});
 const app=new EventEmitter(),ipc=new EventEmitter(),api=module.exports;
 const mainFrame={url:editor+'?dev=0',frameTreeNodeId:7};
 const sender={mainFrame,getURL:()=>editor+'?dev=0'};
 let reply;
 const event={sender,senderFrame:mainFrame,reply(channel,result){assert.equal(channel,api.replyChannel);reply=result;}};
 function install(names=expected){return api.install(app,ipc,editor,names);}
 function request(action,overrides={}){reply=undefined;ipc.emit(api.requestChannel,{...event,...overrides},{action});return reply;}
 return {api,app,ipc,owned,caseRoot,calls,unlinked,event,install,request,send:request=>{reply=undefined;ipc.emit(api.requestChannel,event,request);return reply;}};
}

test('install rejects invalid basenames before registering the private IPC',t=>{
 const run=setup(t);
 for(const name of ['', ' ', '.', '..', '../other', 'a/b', 'a\\b', 'a\0b'])assert.throws(()=>run.install([name]));
 assert.equal(run.ipc.listenerCount(run.api.requestChannel),0);assert.deepEqual(run.calls,[]);
});

test('only the exact original editor main frame can inspect/remove, and dynamic paths are refused',t=>{
 const run=setup(t);run.install();
 const frame={url:editor,frameTreeNodeId:8};
 assert.equal(run.request('remove',{senderFrame:frame}).accepted,false);
 assert.equal(run.request('inspect',{senderFrame:{url:'https://example.invalid/',frameTreeNodeId:7}}).accepted,false);
 assert.equal(run.request('remove',{senderFrame:null}).accepted,false);
 assert.equal(run.send({action:'remove',path:'/storage/Users/currentUser/Download/personal'}).accepted,false);
 assert.equal(run.send({action:'remove',directory:root}).accepted,false);
 assert.deepEqual(run.calls,[]);assert.ok(expected.every(name=>fs.existsSync(path.join(run.owned,name))));
});

test('inspect reads complete metadata without creating the probe or deleting anything',t=>{
 const run=setup(t);run.install();const result=run.request('inspect');
 assert.equal(result.accepted,true);assert.equal(result.success,true);assert.equal(result.preflight.valid,true);
 assert.deepEqual(Array.from(result.preflight.names).sort(),[...expected].sort());
 assert.ok(!run.calls.some(([kind])=>['mkdir','write','unlink','rmdir'].includes(kind)));
});

test('an unexpected entry blocks all mutation before the probe exists',t=>{
 const run=setup(t);fs.writeFileSync(path.join(run.owned,'personal.keep'),'keep');run.install();
 const result=run.request('remove');assert.equal(result.success,false);assert.deepEqual(Array.from(result.preflight.unexpectedNames),['personal.keep']);
 assert.deepEqual(run.unlinked,[]);assert.ok(!run.calls.some(([kind])=>kind==='mkdir'));
 assert.ok(expected.every(name=>fs.existsSync(path.join(run.owned,name))));
});

test('a whitelisted directory or symlink metadata blocks all unlink operations',t=>{
 for(const variant of ['directory','symlink']){
  const run=setup(t,{symlink:variant==='symlink'?'entry':undefined});
  if(variant==='directory'){fs.unlinkSync(path.join(run.owned,expected[0]));fs.mkdirSync(path.join(run.owned,expected[0]));}
  run.install();const result=run.request('remove');assert.equal(result.success,false);assert.ok(result.preflight.nonRegularNames.includes(expected[0]));assert.deepEqual(run.unlinked,[]);
 }
});

test('a symlink-owned-root metadata is rejected without reading its entries',t=>{
 const run=setup(t,{symlink:'root'});run.install();const result=run.request('remove');
 assert.equal(result.success,false);assert.ok(!run.calls.some(([kind])=>kind==='readdir'));assert.deepEqual(run.unlinked,[]);
});

test('real Node nonempty rmdir preserves the sentinel, then exact files and the empty directory are removed',t=>{
 const run=setup(t);const input=[...expected];run.install(input);input.push('outside.keep');
 const result=run.request('remove');assert.equal(result.success,true);assert.equal(result.directoryGone,true);
 assert.equal(result.probe.verified,true);assert.ok(['ENOTEMPTY','EEXIST'].includes(result.probe.rejectedCode));assert.equal(result.probe.sentinelRetained,true);assert.equal(result.probe.probeCleaned,true);
 assert.deepEqual(Array.from(result.removedNames).sort(),[...expected].sort());assert.ok(!fs.existsSync(run.owned));assert.equal(fs.readFileSync(path.join(run.caseRoot,'outside.keep'),'utf8'),'outside');
});

test('a recursive-behaving backend loses only its own probe and never deletes real ledger files',t=>{
 const run=setup(t,{recursiveProbe:true});run.install();const result=run.request('remove');
 assert.equal(result.success,false);assert.equal(result.probe.verified,false);assert.equal(result.probe.sentinelRetained,false);assert.equal(result.probe.probeCleaned,true);
 assert.deepEqual(Array.from(result.removedNames),[]);assert.ok(expected.every(name=>fs.existsSync(path.join(run.owned,name))));
});

test('an unknown file arriving after probe cleanup blocks every real-file deletion',t=>{
 const run=setup(t,{unexpectedAfterProbe:true});run.install();const result=run.request('remove');
 assert.equal(result.success,false);assert.equal(result.partial,false);assert.deepEqual(Array.from(result.removedNames),[]);assert.ok(result.afterProbePreflight.unexpectedNames.includes('unexpected.keep'));
 assert.ok(expected.every(name=>fs.existsSync(path.join(run.owned,name))));
});

test('an unknown file arriving during deletion is preserved and the result reports partial failure',t=>{
 const run=setup(t,{unexpectedAfterDelete:true});run.install();const result=run.request('remove');
 assert.equal(result.success,false);assert.equal(result.partial,true);assert.equal(result.removedNames.length,1);assert.ok(expected.includes(result.removedNames[0]));
 assert.ok(result.latePreflight.unexpectedNames.includes('unexpected.keep'));assert.equal(fs.readFileSync(path.join(run.owned,'unexpected.keep'),'utf8'),'preserve');
 assert.ok(expected.filter(name=>!result.removedNames.includes(name)).every(name=>fs.existsSync(path.join(run.owned,name))));
});

test('an already absent owned directory is idempotent, and dispose unregisters the temporary IPC',t=>{
 const run=setup(t);for(const name of expected)fs.unlinkSync(path.join(run.owned,name));fs.rmdirSync(run.owned);
 const dispose=run.install(),result=run.request('remove');assert.equal(result.success,true);assert.equal(result.alreadyAbsent,true);assert.equal(result.directoryGone,true);
 dispose();assert.equal(run.ipc.listenerCount(run.api.requestChannel),0);assert.equal(run.app.listenerCount('will-quit'),0);
});

test('the diagnostic host has no recursive removal or arbitrary path option',()=>{
 assert.doesNotMatch(source,/recursive\s*:\s*true|rmSync\(|rmdir\([^)]*,/);
});
