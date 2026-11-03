#!/usr/bin/env node
/** Public prompt v3 contract adapter. Node 20+, no third-party packages. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {resolveApiKey} from './lululab_cli.mjs';
import {loadManifest} from './generation_manifest.mjs';
import {publicError,raiseIfAuthorizationUnavailable} from './service_privacy.mjs';
export const SCHEMA = 'lululab.recreate.prompt.v3';
const obj=v=>v!==null && typeof v==='object' && !Array.isArray(v);
const fail=s=>{throw new Error(s)};
export function validateInput(data){
 if(!obj(data)||data.schemaVersion!==SCHEMA) fail('schemaVersion 必须为 '+SCHEMA);
 const x=data.input;if(!obj(x))fail('input必须为对象');
 const media=(v,label)=>{if(!obj(v)||typeof (v.file||v.url)!=='string')fail(label+' 必须包含 file 或 url');if(v.url && !/^https?:\/\//.test(v.url))fail(label+'.url必须是HTTP(S)');};
 media(x.benchmarkVideo,'benchmarkVideo');
 const product=x.product??{mode:'keep_source'};
 if(!obj(product)||!['keep_source','replace'].includes(product.mode??'keep_source'))fail('product.mode必须是keep_source/replace');
 const images=product.images??[];if(!Array.isArray(images))fail('product.images必须为数组');
 images.forEach((p,i)=>{media(p,`product.images[${i}]`);if(!p.url)fail('product.images必须是公网URL；本地上传时请先通过CLI upload')});
 if(product.mode==='replace'&&!images.length)fail('替换商品必须提供product.images');
 if(product.brief!==undefined && product.brief!==null && !obj(product.brief))fail('product.brief必须为对象');
 for(const name of ['sellingPoints','forbiddenChanges'])if(!Array.isArray(product[name]??[])||!(product[name]??[]).every(x=>typeof x==='string'))fail('product.'+name+'必须为字符串数组');
 const creator=x.creator??{mode:'keep_source'};
 if(!obj(creator)||!['keep_source','ai_generated','user_provided'].includes(creator.mode??'keep_source'))fail('creator.mode无效');
 const refs=creator.images??[];if(!Array.isArray(refs))fail('creator.images必须为数组');
 refs.forEach((p,i)=>{media(p,`creator.images[${i}]`);if(!p.url)fail('creator.images必须是公网URL；本地上传时请先通过CLI upload')});
 if(creator.mode==='user_provided'&&!refs.length)fail('user_provided模式必须上传达人图片');
 const settings=x.settings??{};if(!obj(settings))fail('settings必须为对象');
 if(!['source','custom'].includes(settings.durationMode??'source'))fail('durationMode无效');
 if(settings.durationMode==='custom'&&(!Number.isInteger(settings.targetDuration)||settings.targetDuration<=0))fail('custom模式必须设置正整数targetDuration');
 if((settings.durationMode??'source')==='source'&&settings.targetDuration!=null)fail('source模式不接受targetDuration');
 if('storyboardValidationMode' in settings||'maxConcurrency' in settings)fail('质检模式和并发数由系统固定管理，不允许作为Input参数');
 if(data.output!=null)fail('提交输入不可携带output');return data;
}
export function dump(file,v){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(v,null,2)+'\n');fs.renameSync(temp,file)}
function resolveFile(v){return path.resolve(v.startsWith('~/')?path.join(os.homedir(),v.slice(2)):v)}
function cliCall(cli,argv,key){
 const node=process.env.LULULAB_NODE?.trim()||process.execPath;
 const result=spawnSync(node,[cli,...argv],{encoding:'utf8',env:{...process.env,LULULAB_API_KEY:key},timeout:180000});
 if(result.error||result.status!==0){
  const detail=String(result.error?.message||result.stderr||result.stdout||'CLI failed').replaceAll(key,'[REDACTED]');
  raiseIfAuthorizationUnavailable(detail);
  fail(publicError(detail.slice(0,1000),'LuluLab CLI failed'));
 }
 for(const candidate of [result.stdout,...result.stdout.trim().split('\n').reverse()]){
  try{
   const parsed=JSON.parse(candidate.replaceAll(key,'[REDACTED]'));
   if(!obj(parsed))continue;
   raiseIfAuthorizationUnavailable(parsed);
   const queue=[parsed];
   while(queue.length){
    const value=queue.shift();
    if(Array.isArray(value)){queue.push(...value);continue}
    if(!obj(value))continue;
    if(value.success===false||value.ok===false||value.error)
     fail(publicError(value.message||value.error||'LuluLab 返回失败响应。','LuluLab 返回失败响应。'));
    queue.push(...Object.values(value).filter(item=>obj(item)||Array.isArray(item)));
   }
   return parsed;
  }catch(error){if(error instanceof SyntaxError)continue;throw error}
 }
 fail('LuluLab CLI返回内容不是JSON对象。');
}
function resolveCli(){
 const cli=resolveFile(process.env.LULULAB_CLI?.trim()||path.join(path.dirname(fileURLToPath(import.meta.url)),'lululab_cli.mjs'));
 if(path.extname(cli)!=='.mjs'||!fs.existsSync(cli)||!fs.statSync(cli).isFile())fail('未发现 Node.js LuluLab CLI：scripts/lululab_cli.mjs');
 return cli;
}
function extractMedia(response,mimeType){
 const queue=[response];
 while(queue.length){
  const item=queue.shift();
  if(Array.isArray(item)){queue.push(...item);continue}
  if(!obj(item))continue;
  const url=item.url||item.downloadUrl||item.outputUrl;
  if(typeof url==='string'&&/^https?:\/\//.test(url))return {url:url.trim(),mimeType,expiredAt:item.expiredAt||item.expiresAt||null};
  queue.push(...Object.values(item).filter(value=>obj(value)||Array.isArray(value)));
 }
 fail('upload响应缺少有效HTTP(S)媒体URL。');
}
export function publicMedia(item,{cache,uploadMissing=false,cli=null,key=null,mediaType='image/png'}={}){
 if(obj(item)&&typeof item.url==='string'&&/^https?:\/\//.test(item.url))return Object.fromEntries(['url','mimeType','expiredAt'].filter(k=>item[k]!=null).map(k=>[k,item[k]]));
 const value=obj(item)?(item.file||item.filePath):item;if(typeof value!=='string'||!value)return null;
 if(/^https?:\/\//.test(value))return {url:value,mimeType:mediaType};
 const p=resolveFile(value);if(!fs.existsSync(p)||!fs.statSync(p).isFile())fail('待上传媒体文件不存在: '+p);
 const hash=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
 if(cache[p]?.sha256===hash&&cache[p]?.media?.url)return cache[p].media;
 if(!uploadMissing||!cli||!key)fail(p+' 尚未上传。使用 export --upload-missing 自动调用 LuluLab CLI');
 const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.avif':'image/avif'}[path.extname(p).toLowerCase()]||mediaType;
 const response=cliCall(cli,['upload',p],key);
 const media=extractMedia(response,mime);cache[p]={sha256:hash,media};return media;
}
export async function exportPrompt(manifestFile,{uploadMissing=false}={}){
 manifestFile=resolveFile(manifestFile);
 const m=await loadManifest(manifestFile);
 const cachePath=path.join(path.dirname(manifestFile),'exports','public-media-cache.json');const cache=fs.existsSync(cachePath)?JSON.parse(fs.readFileSync(cachePath,'utf8')):{};
 let cli=null,key=null;
 if(uploadMissing){
  cli=resolveCli();key=await resolveApiKey();
  const auth=cliCall(cli,['user','--credits'],key);
  if(typeof auth.balance!=='number'||!Number.isFinite(auth.balance))fail('LuluLab user --credits 未返回文档规定的有效鉴权响应。');
 }
 const media=v=>{const result=publicMedia(v,{cache,uploadMissing,cli,key});if(uploadMissing)dump(cachePath,cache);return result};
 const analysis=m.benchmarkVideo?.analysis??{};
 const windows=new Map((analysis.recommendedSegments??[]).map(s=>[Number(s.segmentId),s]));
 const boards=new Map((m.storyboards?.generation??[]).map(s=>[Number(s.segmentId??s.storyboardId??-1),s]));
 const prompts=new Map((m.videoPrompts?.segments??[]).map(s=>[Number(s.segmentId),s]));
 const segments=[...new Set([...windows.keys(),...prompts.keys()])].sort((a,b)=>a-b).map(sid=>{
  const w=windows.get(sid)??{},p=prompts.get(sid)??{},target=boards.get(sid)??{};
  const targetRef=target.file??(target.url?{url:target.url}:null);
  const ready=Boolean(p.prompt&&targetRef);
  return {segmentId:sid,status:ready?'completed':'processing',duration:p.duration??w.duration??null,prompt:p.prompt??null,targetStoryboard:targetRef?media(targetRef):null};
 });
 const expected=windows.size,completed=segments.filter(s=>s.status==='completed').length;
 const status=expected&&completed===expected?'completed':completed?'partial':'processing';
 const product=m.product??{},creator=m.creator??{};
 return {schemaVersion:SCHEMA,taskId:m.taskId??null,module:'recreate_prompt_generation',status,success:status==='completed',progress:{totalSegments:expected,completedSegments:completed},output:{segments,product:{mode:product.useBenchmarkProduct??true?'keep_source':'replace',brief:product.brief??null,referenceImages:(product.productImages??[]).filter(Boolean).map(media)},creator:{mode:creator.mode??'keep_source',referenceImages:(m.creators??[]).flatMap(c=>(c.referenceImages??[c.file]).filter(Boolean).map(media))}},videoGenerationIncluded:false};
}
function arg(name){const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1]}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const command=process.argv[2];let result;if(command==='validate-input'){const file=arg('--input');if(!file)fail('missing --input');result=validateInput(JSON.parse(fs.readFileSync(file,'utf8')))}else if(command==='export'){const file=arg('--manifest');if(!file)fail('missing --manifest');result=await exportPrompt(file,{uploadMissing:process.argv.includes('--upload-missing')});if(arg('--output'))dump(arg('--output'),result)}else fail('expected validate-input or export');console.log(JSON.stringify(result))}catch(e){console.error(e.message);process.exitCode=1}
}
