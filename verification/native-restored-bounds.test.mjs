import { typeScriptPath } from './sdk-paths.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require=createRequire(import.meta.url);
const ts=require(typeScriptPath());
function fixture(visible=true,options={}){
 const text=fs.readFileSync(new URL('../harmony-electron/web_engine/src/main/ets/adapter/AppWindowAdapter.ets',import.meta.url),'utf8');
 const parsed=ts.createSourceFile('AppWindowAdapter.ets',text,ts.ScriptTarget.Latest,true);
 const klass=parsed.statements.find(node=>ts.isClassDeclaration(node)&&node.name.text==='AppWindowAdapter');
 const names=new Set(['boundsGeneration','normalBounds','rememberNormalBounds','getWindow','setBounds','applyBounds','unMaximize','maximize','setFullScreen','setSimpleFullScreen','syncCaptionStatus']);
 const methods=klass.members.filter(node=>names.has(node.name?.getText(parsed))).map(node=>node.getText(parsed).replace(/^@LogMethod\s*/, '')).join('\n');
 const code=ts.transpileModule('export class Subject{'+methods+'}',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 const exports={},moves=[],sizes=[],expansions=[];
 vm.runInNewContext(code,{exports,TAG:'restore-test',deviceInfo:{deviceType:'2in1'},LogUtil:{info(){},error(){}},
  window:{WindowStatusType:{FLOATING:4,MAXIMIZE:2,FULL_SCREEN:1},MaximizePresentation:{EXIT_IMMERSIVE:0,ENTER_IMMERSIVE:1,ENTER_IMMERSIVE_DISABLE_TITLE_AND_DOCK_HOVER:2}},
  display:{getDisplayByIdSync:()=>({getAvailableArea:options.area||(()=>Promise.resolve({left:0,top:78,width:2880,height:1842}))})}});
 const native={recover:()=>Promise.resolve(),getWindowStatus:()=>4,
  getWindowProperties:()=>({displayId:2,drawableRect:{left:0,top:0},windowRect:{left:0,top:78,width:3200,height:1842}}),
  getUIContext:()=>({getSharedLocalStorage:()=>({get:()=>visible,set(){}})}),
  maximize:mode=>{expansions.push(mode);return options.expansion||Promise.resolve();},
  setTitleAndDockHoverShown:()=>Promise.resolve(),
  moveWindowToAsync:(...args)=>{moves.push(args);return options.move||Promise.resolve();},
  resizeAsync:(...args)=>{sizes.push(args);return Promise.resolve();}};
 const subject=new exports.Subject();
 subject.abilityManager={getProxy:()=>({getWindow:()=>native,getWindowPreferences:()=>({hideTitleBar:true})})};
 subject.deviceInfoAdapter={isPcMode:()=>true};
 return{subject,moves,sizes,expansions,native};
}

function deferred(){let resolve;const promise=new Promise(accept=>{resolve=accept;});return{promise,resolve};}

test('recovering an oversized visible editor refits the native caption into the physical work area',async()=>{
 const run=fixture();run.subject.unMaximize(3);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(run.moves,[[0,78]]);
 assert.deepEqual(run.sizes,[[2880,1842]]);
});

test('recover does not resize an intentionally hidden export window',async()=>{
 const run=fixture(false);run.subject.unMaximize(3);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(run.moves,[]);assert.deepEqual(run.sizes,[]);
});

for(const mode of ['maximize','fullscreen','simple-fullscreen']){
 test(`${mode} intent invalidates a delayed recover work area before native status changes`,async()=>{
  const area=deferred(),expansion=deferred();
  const run=fixture(true,{area:()=>area.promise,expansion:expansion.promise});
  run.subject.unMaximize(3);
  await new Promise(resolve=>setImmediate(resolve));
  if(mode==='maximize')run.subject.maximize(3);
  else if(mode==='fullscreen')run.subject.setFullScreen(true,3);
  else run.subject.setSimpleFullScreen(true,3);
  assert.equal(run.expansions.length,1);
  assert.equal(run.native.getWindowStatus(),4,'The SDK has not published the expanded status yet');
  area.resolve({left:0,top:78,width:2880,height:1842});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(run.moves,[]);
  assert.deepEqual(run.sizes,[]);
  expansion.resolve();
 });
}

test('maximize intent also invalidates a recover move completion while native status is still floating',async()=>{
 const move=deferred(),expansion=deferred();
 const run=fixture(true,{move:move.promise,expansion:expansion.promise});
 run.subject.unMaximize(3);
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(run.moves,[[0,78]]);
 assert.deepEqual(run.sizes,[]);
 run.subject.maximize(3);
 assert.equal(run.expansions.length,1);
 assert.equal(run.native.getWindowStatus(),4);
 move.resolve();
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(run.sizes,[]);
 expansion.resolve();
});
