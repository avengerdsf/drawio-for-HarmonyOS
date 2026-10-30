import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const directory='/storage/Users/currentUser/Download/drawio-test-tmp';
export const requestChannel='__diagramdesk_acceptance_cleanup_request_v1';
export const replyChannel='__diagramdesk_acceptance_cleanup_reply_v1';
const baseURL=value=>typeof value==='string'?value.split(/[?#]/,1)[0]:'';
const failure=error=>({code:typeof error?.code==='string'?error.code:'UNKNOWN',message:error?.message||String(error)});
const basename=value=>typeof value==='string'&&value.trim().length>0&&value!=='.'&&value!=='..'&&!/[\\/\0]/.test(value);

function sameDirectory(expected){
 const current=fs.lstatSync(directory,{bigint:true});
 if(current.isSymbolicLink()||!current.isDirectory()||current.dev!==expected.dev||current.ino!==expected.ino)throw Error('Owned directory identity changed');
}

function preflight(expectedNames){
 let stat;
 try{stat=fs.lstatSync(directory,{bigint:true});}catch(error){if(error.code==='ENOENT')return {valid:true,absent:true,names:[],unexpectedNames:[],nonRegularNames:[]};throw error;}
 if(stat.isSymbolicLink()||!stat.isDirectory())return {valid:false,absent:false,names:[],unexpectedNames:[],nonRegularNames:[],reason:'Owned path is not a regular directory'};
 const names=fs.readdirSync(directory),unexpectedNames=names.filter(name=>!basename(name)||!expectedNames.includes(name));
 const nonRegularNames=[];
 for(const name of names){
  if(!basename(name)||!expectedNames.includes(name))continue;
  const entry=fs.lstatSync(path.join(directory,name));
  if(entry.isSymbolicLink()||!entry.isFile())nonRegularNames.push(name);
 }
 return {valid:unexpectedNames.length===0&&nonRegularNames.length===0,absent:false,names,unexpectedNames,nonRegularNames,identity:stat};
}

function metadata(snapshot){
 return {valid:snapshot.valid,absent:snapshot.absent,names:snapshot.names,unexpectedNames:snapshot.unexpectedNames,
  nonRegularNames:snapshot.nonRegularNames,reason:snapshot.reason};
}

function verifyNonrecursiveRemoval(identity){
 const name='.native-cleanup-probe-'+randomUUID(),probe=path.join(directory,name),sentinel=path.join(probe,'owned-sentinel.txt');
 const result={name,verified:false,rejectedCode:null,sentinelRetained:false,probeCleaned:false};
 let created=false,probeStat,sentinelStat;
 try{
  sameDirectory(identity);
  fs.mkdirSync(probe,{mode:0o700});created=true;probeStat=fs.lstatSync(probe,{bigint:true});
  if(probeStat.isSymbolicLink()||!probeStat.isDirectory())throw Error('Owned probe is not a directory');
  fs.writeFileSync(sentinel,'owned-nonrecursive-probe',{flag:'wx',mode:0o600});
  sentinelStat=fs.lstatSync(sentinel,{bigint:true});
  try{fs.rmdirSync(probe);}catch(error){result.rejectedCode=error.code||'UNKNOWN';}
  try{const stat=fs.lstatSync(sentinel,{bigint:true});result.sentinelRetained=stat.isFile()&&!stat.isSymbolicLink()&&stat.dev===sentinelStat.dev&&stat.ino===sentinelStat.ino;}catch{}
  result.verified=['ENOTEMPTY','EEXIST'].includes(result.rejectedCode)&&result.sentinelRetained;
  if(!result.verified)result.error={code:'UNSAFE_RMDIR',message:'Nonempty rmdir did not reject while retaining the owned sentinel'};
 }catch(error){result.error=failure(error);}
 finally{
  if(created){
   try{
    sameDirectory(identity);
    let current;
    try{current=fs.lstatSync(probe,{bigint:true});}catch(error){if(error.code==='ENOENT')result.probeCleaned=true;else throw error;}
    if(current){
     if(!probeStat||current.isSymbolicLink()||!current.isDirectory()||current.dev!==probeStat.dev||current.ino!==probeStat.ino)throw Error('Owned probe identity changed; cleanup refused');
     const names=fs.readdirSync(probe);
     if(names.some(entry=>entry!=='owned-sentinel.txt'))throw Error('Unexpected probe entry; cleanup refused');
     if(names.length){const stat=fs.lstatSync(sentinel,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink()||!sentinelStat||stat.ino!==sentinelStat.ino||stat.dev!==sentinelStat.dev)throw Error('Owned sentinel identity changed');fs.unlinkSync(sentinel);}
     fs.rmdirSync(probe);result.probeCleaned=true;
    }
   }catch(error){result.cleanupError=failure(error);}
  }
 }
 return result;
}

function remove(expectedNames){
 const result={success:false,directory,removedNames:[],partial:false,directoryGone:false};
 try{
  const initial=preflight(expectedNames);result.preflight=metadata(initial);
  if(!initial.valid)return result;
  if(initial.absent){result.success=true;result.directoryGone=true;result.alreadyAbsent=true;return result;}
  result.probe=verifyNonrecursiveRemoval(initial.identity);
  if(!result.probe.verified||!result.probe.probeCleaned)return result;
  sameDirectory(initial.identity);
  let current=preflight(expectedNames);result.afterProbePreflight=metadata(current);
  if(!current.valid||current.absent)return result;
  for(const name of current.names){
   sameDirectory(initial.identity);
   current=preflight(expectedNames);
   if(!current.valid||current.absent){result.latePreflight=metadata(current);result.partial=result.removedNames.length>0;return result;}
   if(!current.names.includes(name))throw Error('An owned file disappeared during removal');
   const target=path.join(directory,name),stat=fs.lstatSync(target);
   if(stat.isSymbolicLink()||!stat.isFile())throw Error('An owned file changed type; removal stopped');
   fs.unlinkSync(target);result.removedNames.push(name);
  }
  sameDirectory(initial.identity);
  current=preflight(expectedNames);result.finalPreflight=metadata(current);
  if(!current.valid||current.names.length){result.partial=result.removedNames.length>0;return result;}
  fs.rmdirSync(directory);
  try{fs.lstatSync(directory);throw Error('Owned directory still exists after rmdir');}catch(error){if(error.code!=='ENOENT')throw error;}
  result.success=true;result.directoryGone=true;
 }catch(error){result.error=failure(error);result.partial=result.removedNames.length>0;}
 return result;
}

export function install(app,ipcMain,editorURL,expectedNames){
 if(!Array.isArray(expectedNames)||expectedNames.some(name=>!basename(name)))throw TypeError('Expected names must be nonempty individual basenames');
 const names=Object.freeze([...new Set(expectedNames)]);
 const authorized=event=>{
  try{
   const frame=event.senderFrame,main=event.sender?.mainFrame;
   return !!frame&&!!main&&baseURL(frame.url)===editorURL&&baseURL(event.sender.getURL())===editorURL&&
    (frame===main||Number.isInteger(frame.frameTreeNodeId)&&frame.frameTreeNodeId===main.frameTreeNodeId);
  }catch{return false;}
 };
 function handler(event,request){
  if(!authorized(event)||!['inspect','remove'].includes(request?.action)||request.path!==undefined||request.directory!==undefined||request.uri!==undefined){event.reply(replyChannel,{accepted:false});return;}
  let result;
  try{if(request.action==='inspect'){const snapshot=preflight(names);result={success:snapshot.valid,directory,preflight:metadata(snapshot)};}else result=remove(names);}
  catch(error){result={success:false,directory,error:failure(error)};}
  event.reply(replyChannel,{accepted:true,action:request.action,...result});
 }
 function dispose(){ipcMain.removeListener(requestChannel,handler);app.removeListener('will-quit',dispose);}
 ipcMain.on(requestChannel,handler);app.once('will-quit',dispose);
 return dispose;
}
