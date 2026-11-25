#!/usr/bin/env node
// Issue observations never authorize a merge, deployment or installation.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as mergeVerify from './merge-verify.mjs';
import { resolveTrustedDefault } from './default-ref.mjs';
import { repoSlug } from './clean-state.mjs';
import { saveState, withStateLock, runsDir } from './run-state.mjs';
import { findSecrets, redactText } from './secret-patterns.mjs';
import { validRunId } from './ids.mjs';
import { isMain } from './is-main.mjs';
import { appendFailure, ISSUE_EVENTS, FAILURE_CATEGORIES } from './issues-failure-log.mjs';
import { readSets, validateCard } from './questions.mjs';

export const LABELS = Object.freeze([
  {name:'harness-defect',color:'d73a4a',description:'Harness defect'},
  {name:'security',color:'b60205',description:'Security relevant'},
  ...['high','medium','low'].map((s,i)=>({name:`sev:${s}`,color:['b60205','fbca04','0e8a16'][i],description:`${s} severity`})),
  ...['S0-sync','S1-jev','S2-deploy-state','S3-skill-text','S4-guard-hook','S5-self-repair'].map(s=>({name:`slice:${s}`,color:'5319e7',description:`Slice ${s}`})),
  ...['triaged','in-progress','in-review','merged','released'].map(s=>({name:`status:${s}`,color:'1d76db',description:`Issue ${s}`})),
  {name:'status:deployed-qa',color:'1d76db',description:'Verified QA delivery'},
  {name:'status:deployed-prod',color:'0e8a16',description:'Verified production delivery'},
  {name:'slice:S6-issue-tracking',color:'5319e7',description:'Slice S6 issue tracking'},
  {name:'wontfix',color:'ffffff',description:'This will not be worked on'}
].map(Object.freeze));
export const BACKFILL_KEYS = Object.freeze(['hf0','sync','g1','e1-e2','problem-a','usage','thresholds','n2','n3','d9','d2','d3','d4','n1','d5','build-args-spread','d7','d8','inv48-m2','inv48-h1','s5-self-repair','s6-issue-tracking','d11']);
const KEY=/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const SLUG=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const LOGIN=/^[A-Za-z0-9-]+(\[bot\])?$/;
const STATUSES=['triaged','in-progress','in-review','merged','deployed-qa','deployed-prod','released'];
const now=()=>new Date().toISOString();
const hash=s=>createHash('sha256').update(s).digest('hex');
const names=labels=>(labels||[]).map(l=>typeof l==='string'?l:l.name);
const refuse=(code,extra={})=>{throw Object.assign(new Error(code),{code,...extra});};
const checkedRun=run=>{if(!validRunId(run))refuse('RUN_ID_INVALID');return run;};
const checkedKey=key=>{if(key===undefined||key===null||key==='')refuse('ISSUE_KEY_REQUIRED');if(typeof key!=='string'||!KEY.test(key))refuse('ISSUE_KEY_INVALID');return key;};
const gitIn=checkout=>args=>execFileSync('git',args,{cwd:checkout,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'}});
function scan(...texts) {
  const hits=texts.flatMap(t=>findSecrets(t));
  if(hits.length)refuse('ISSUE_TEXT_SECRET',{rules:hits});
  return texts.map(t=>redactText(String(t??'')));
}
const empty=repo=>({version:1,repo,issues:{},pending:[],refusals:[]});
const liveMetadata=e=>({number:e.number,title:redactText(e.title||''),state:e.state,labels:names(e.labels)});
function validateLedger(l) {
  if(!l||l.version!==1||!SLUG.test(l.repo)||!l.issues||Array.isArray(l.issues)||!Array.isArray(l.pending)||!Array.isArray(l.refusals))refuse('ISSUES_LEDGER_UNREADABLE');
  const keys=new Set();
  for(const [key,e] of Object.entries(l.issues)){
    if(!KEY.test(key)||keys.has(key.toLowerCase())||!e||e.key!==key||!Number.isInteger(e.number)||e.number<1||typeof e.url!=='string'||typeof e.title!=='string'||![...STATUSES,'withdrawn'].includes(e.status)||!['labels','observedLabels','history','prs','deliveries','rollbacks'].every(k=>Array.isArray(e[k]))||!(e.mergeSha===null||typeof e.mergeSha==='string'))refuse('ISSUES_LEDGER_UNREADABLE');
    keys.add(key.toLowerCase());
  }
  return l;
}

// All real issue calls, including reads, use this one verified runner.
export async function makeAgentGh({checkout,repo,env=process.env,spawn,git=gitIn(checkout),remote='origin'}={}) {
  if(!env.GH_CONFIG_DIR)refuse('IDENTITY_NOT_CONFIGURED');
  let directory;try{directory=realpathSync(env.GH_CONFIG_DIR);}catch{refuse('IDENTITY_NOT_CONFIGURED');}
  const defaults=[join(env.HOME||homedir(),'.config','gh'),join(env.XDG_CONFIG_HOME||join(env.HOME||homedir(),'.config'),'gh')];
  if(defaults.some(p=>{try{return realpathSync(p)===directory;}catch{return resolve(p)===directory;}}))refuse('IDENTITY_IS_DEFAULT_GH_DIR');
  let trusted;
  try{trusted=resolveTrustedDefault({repo:checkout,remote,git});}
  catch(e){refuse('IDENTITY_CONFIG_UNTRUSTED',{defaultCode:/^(DEFAULT_|REMOTE_)[A-Z_]+$/.test(e.code)?e.code:'DEFAULT_UNVERIFIED'});}
  let config;
  try{config=JSON.parse(String(git(['show',`${trusted.sha}:.trioharness/issues.json`])));}catch{refuse('IDENTITY_NOT_CONFIGURED');}
  if(!config||config.version!==1||typeof config.repo!=='string'||typeof config.agentLogin!=='string'||!Array.isArray(config.ownerLogins)||!config.ownerLogins.every(x=>typeof x==='string'&&LOGIN.test(x)))refuse('IDENTITY_NOT_CONFIGURED');
  if(!LOGIN.test(config.agentLogin)||config.ownerLogins.some(x=>x.toLowerCase()===config.agentLogin.toLowerCase()))refuse('IDENTITY_CONFIG_INVALID');
  let remoteSlug;try{remoteSlug=repoSlug(String(git(['remote','get-url',trusted.remoteName])).trim());}catch{refuse('IDENTITY_CONFIG_REPO_MISMATCH');}
  if(!SLUG.test(repo)||config.repo!==repo||repo!==remoteSlug)refuse('IDENTITY_CONFIG_REPO_MISMATCH');
  const child={...env,GH_CONFIG_DIR:directory,GH_PROMPT_DISABLED:'1'};
  for(const key of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GH_HOST','GH_REPO'])delete child[key];
  const invoke=spawn||((args,input,options)=>mergeVerify.ghCli(args,input,options));
  let viewer;
  try{const r=await invoke(['api','graphql','-f','query={viewer{login}}'],undefined,{env:child});if(!r.ok)refuse('IDENTITY_UNVERIFIED');viewer=JSON.parse(r.out)?.data?.viewer?.login;}catch{refuse('IDENTITY_UNVERIFIED');}
  if(typeof viewer!=='string'||!viewer)refuse('IDENTITY_UNVERIFIED');
  if(config.ownerLogins.some(x=>x.toLowerCase()===viewer.toLowerCase()))refuse('IDENTITY_IS_OWNER');
  if(viewer.toLowerCase()!==config.agentLogin.toLowerCase())refuse('IDENTITY_MISMATCH');
  return Object.assign(async(args,input)=>invoke(args,input,{env:child}),{config,trustedDefault:trusted});
}

export async function ensureLabels(gh,repo) {
  const r=await gh(['api',`repos/${repo}/labels?per_page=100`,'--paginate','--slurp']);
  if(!r.ok)return {ok:false,error:redactText(r.err||r.out||'').slice(0,300)};
  let rows;try{rows=JSON.parse(r.out).flat();if(!Array.isArray(rows))throw new Error();}catch{return {ok:false,error:'GH_JSON_UNREADABLE'};}
  const known=new Map(rows.map(l=>[l.name.toLowerCase(),l])),created=[],drift=[];
  for(const label of LABELS){
    const old=known.get(label.name.toLowerCase());
    if(old){if(String(old.color).toLowerCase()!==label.color||old.description!==label.description)drift.push(label.name);continue;}
    const made=await gh(['api',`repos/${repo}/labels`,'-X','POST','--input','-'],JSON.stringify(label));
    const collisionText=`${made.err||''} ${made.out||''}`;
    if(!made.ok&&!(/422/.test(collisionText)&&/already[ _-]exists/i.test(collisionText)))return {ok:false,error:redactText(made.err||made.out||'').slice(0,300)};
    if(made.ok)created.push(label.name);
  }
  return {ok:true,created,drift};
}

export function assertLedgerGrowth(previous,next) {
  if(!previous)return true;
  for(const [k,e] of Object.entries(previous.issues)){
    const n=next.issues[k];
    if(!n||['history','prs','deliveries','rollbacks'].some(f=>!Array.isArray(n[f])||n[f].length<e[f].length)||e.history.some((h,i)=>JSON.stringify(h)!==JSON.stringify(n.history[i])))refuse('LEDGER_SHRINK');
  }
  if(next.pending.length<previous.pending.length||next.refusals.length<previous.refusals.length)refuse('LEDGER_SHRINK');
  return true;
}

export function acquireAdoptLock(ledger) {
  const path=join(ledger,'.trioharness-direct','issues.lock'),token=randomUUID();
  mkdirSync(join(ledger,'.trioharness-direct'),{recursive:true});
  try{writeFileSync(path,JSON.stringify({token,pid:process.pid,host:hostname(),startedAt:now()}),{flag:'wx'});return {ok:true,path,token};}
  catch(e){if(e.code==='EEXIST')return {ok:false,code:'ADOPT_LOCKED',path};throw e;}
}
export function releaseAdoptLock(lock) {
  try{if(!lock?.ok||JSON.parse(readFileSync(lock.path,'utf8')).token!==lock.token)return {ok:false,code:'ADOPT_LOCK_NOT_OWNED'};
    unlinkSync(lock.path);return {ok:true};
  }catch{return {ok:false,code:'ADOPT_LOCK_NOT_OWNED'};}
}

export function createFileStore(ledger,{beforeSave}={}) {
  const dir=run=>join(runsDir(ledger),checkedRun(run));
  const read=run=>{const path=join(dir(run),'issues.json');return existsSync(path)?validateLedger(JSON.parse(readFileSync(path,'utf8'))):null;};
  return {
    read,
    write(run,next){return withStateLock(ledger,checkedRun(run),()=>{validateLedger(next);assertLedgerGrowth(read(run),next);const path=join(dir(run),'issues.json');beforeSave?.(path,next);saveState(path,next);});},
    list:()=>existsSync(runsDir(ledger))?readdirSync(runsDir(ledger)).filter(validRunId).filter(r=>existsSync(join(dir(r),'issues.json'))).sort():[],
    finished(run){try{return JSON.parse(readFileSync(join(dir(run),'state.json'),'utf8')).finished===true;}catch{return false;}},
    writeBody(run,number,body){const folder=dir(run);mkdirSync(folder,{recursive:true});const path=join(folder,`issue-${number}.md`);writeFileSync(path,body,{flag:'wx'});return path;},
    readSets:run=>readSets(ledger,run),lock:()=>acquireAdoptLock(ledger),unlock:lock=>releaseAdoptLock(lock)
  };
}

function resolveFailures(ledger,run,event,keys) {
  try{
    const path=join(runsDir(ledger),checkedRun(run),'issues-failures.jsonl');if(!existsSync(path))return;
    const unresolved=new Map();
    for(const s of readFileSync(path,'utf8').trimEnd().split('\n')){
      const r=JSON.parse(s);
      if(r.v!==1||r.run!==run||!ISSUE_EVENTS.includes(r.event)||!FAILURE_CATEGORIES.includes(r.category)||!['failure','resolved'].includes(r.kind)||Object.keys(r).some(k=>!['v','kind','ts','run','event','category','key'].includes(k))||('key'in r&&!KEY.test(r.key)))return;
      const id=JSON.stringify([r.event,r.key??null]);if(r.kind==='failure')unresolved.set(id,r);else unresolved.delete(id);
    }
    for(const r of unresolved.values())if(r.event===event&&(!r.key||keys.includes(r.key)))appendFileSync(path,JSON.stringify({v:1,kind:'resolved',ts:now(),run,event,category:r.category,...(r.key?{key:r.key}:{})})+'\n',{flag:'a'});
  }catch{ /* Malformed logs remain blocked in clean-state. */ }
}

export function createIssues(opts={}) {
  const checkout=resolve(opts.checkout||(!SLUG.test(opts.repo||'')?opts.repo:opts.ledger)||'.');
  const ledgerRoot=resolve(opts.ledger||checkout),run=opts.run,git=opts.git||gitIn(checkout),store=opts.store||createFileStore(ledgerRoot);
  let repo=opts.repo,gh=opts.gh,config=opts.config;
  const slug=()=>{if(!SLUG.test(repo||''))repo=repoSlug(String(git(['remote','get-url','origin'])).trim());if(!SLUG.test(repo||''))refuse('IDENTITY_CONFIG_REPO_MISMATCH');return repo;};
  const runner=async()=>{slug();if(!gh){gh=await makeAgentGh({checkout,repo,env:opts.env||process.env,remote:opts.remote||'origin',git,spawn:opts.spawn});config=gh.config;}if(!config)config=gh.config;return gh;};
  const load=(r=run)=>{const l=store.read(checkedRun(r))||empty(slug());if(l.repo!==slug())refuse('ISSUES_LEDGER_REPO_MISMATCH');return l;};
  const persist=(l,r=run)=>store.write(checkedRun(r),l);
  const trusted=()=>opts.trustedDefault?opts.trustedDefault():resolveTrustedDefault({repo:checkout,remote:opts.remote||'origin',git});
  // Only exit 1 proves non-containment; missing objects and other git failures are unknown.
  const ancestor=(a,b)=>{if(!SHA.test(a||'')||!SHA.test(b||''))return null;try{if(opts.ancestor){const r=opts.ancestor(a,b);return typeof r==='boolean'?r:null;}git(['merge-base','--is-ancestor',a,b]);return true;}catch(e){return e.status===1?false:null;}};
  const owners=login=>typeof login==='string'&&config?.ownerLogins.some(o=>o.toLowerCase()===login.toLowerCase());
  const api=async(path,method,input)=>{
    const call=await runner(),args=['api',`repos/${slug()}/${path}`,...(method?['-X',method,'--input','-']:[])];let r;
    try{r=await call(args,input===undefined?undefined:JSON.stringify(input));}catch{refuse('GH_UNAVAILABLE');}
    if(!r?.ok)refuse('GH_UNAVAILABLE',{safeError:redactText(r?.err||r?.out||'').slice(0,300)});
    try{return JSON.parse(r.out);}catch{refuse('GH_UNAVAILABLE',{safeError:'GH_JSON_UNREADABLE'});}
  };
  const paginated=async path=>{
    const call=await runner(),r=await call(['api',`repos/${slug()}/${path}`,'--paginate','--slurp']);
    if(!r.ok)refuse('GH_UNAVAILABLE',{safeError:redactText(r.err||r.out||'').slice(0,300)});
    try{const a=JSON.parse(r.out).flat();if(!Array.isArray(a))throw new Error();return a;}catch{refuse('GH_UNAVAILABLE');}
  };
  const ownCreated=value=>{if(typeof value?.user?.login!=='string'||value.user.login.toLowerCase()!==config?.agentLogin.toLowerCase())refuse('IDENTITY_MISMATCH');return value;};
  const labels=async(e,status,extra=[])=>{
    const live=await api(`issues/${e.number}`),next=[...new Set([...names(live.labels).filter(l=>!l.startsWith('status:')),...extra,...(status==='withdrawn'?['wontfix']:[`status:${status}`])])];
    await api(`issues/${e.number}/labels`,'PUT',{labels:next});e.labels=next;
  };
  const status=async(l,e,to,{internal=false,allowRegress=false,evidence={}}={})=>{
    if(e.status==='withdrawn')refuse('STATUS_WITHDRAWN');
    if(!STATUSES.includes(to))refuse('STATUS_INVALID');
    if(!internal&&!['in-progress','in-review'].includes(to))refuse('STATUS_NEEDS_PROOF');
    if(STATUSES.indexOf(to)<STATUSES.indexOf(e.status)&&!allowRegress)refuse('STATUS_REGRESSION');
    await labels(e,to);if(e.status!==to){e.status=to;e.history.push({status:to,at:now(),by:config.agentLogin,...evidence});}
  };
  const select=(l,o)=>{
    if(o.issues){return String(o.issues).split(',').map(id=>{const e=l.issues[id]||Object.values(l.issues).find(e=>String(e.number)===id.replace(/^#/,''));if(!e)refuse('ISSUE_NOT_FOUND');return e;});}
    const keys=o.keys?String(o.keys).split(','):o.key?[o.key]:Object.keys(l.issues);
    return keys.map(k=>{checkedKey(k);if(!l.issues[k])refuse('ISSUE_NOT_FOUND');return l.issues[k];});
  };
  // Only forward-status retries can be superseded. PR registration, comments, delivery,
  // rollback and install operations have other effects that a later status cannot prove.
  const supersededStatus=(l,p)=>{
    const args=p.args||{};let target;
    if(p.op==='set-status'&&KEY.test(args.key||'')&&['in-progress','in-review'].includes(args.status))target=args.status;
    else if(p.op==='transition'&&args.event==='writer-start')target='in-progress';
    else return null;
    // set-status itself selects only --key; extra batch selectors cannot change its target.
    try{const selected=select(l,p.op==='set-status'?{key:args.key}:args);return selected.length&&selected.every(e=>STATUSES.indexOf(e.status)>=STATUSES.indexOf(target))?selected.map(e=>e.key):null;}catch{return null;}
  };
  const resolveSuperseded=(l,p,keys)=>{
    p.resolved={at:now(),reason:'superseded'};persist(l);
    if(p.op==='transition')resolveFailures(ledgerRoot,run,'writer-start',keys);
  };
  const trackedHook=event=>{
    try{if(store.read(checkedRun(run)))return true;}catch{if(existsSync(join(runsDir(ledgerRoot),String(run),'issues.json')))return true;}
    if(['deployed-qa','deployed-prod','rollback'].includes(event))try{
      const expected=slug();return store.list().some(r=>{try{return store.read(r)?.repo===expected;}catch{return false;}});
    }catch{}
    return false;
  };
  const pending=(op,o,error,r=run)=>{
    const l=load(r),args={};
    for(const k of ['key','keys','title','body','reason','status','labels','completed','notPlanned','issue','issues','pr','event','target','sha','revision','toSha','toRevision','cardSet','installEvidence'])if(o[k]!==undefined)args[k]=typeof o[k]==='string'?redactText(o[k]):o[k];
    l.pending.push({op,key:KEY.test(o.key||'')?o.key:null,args,error:redactText(error.safeError||error.code||'OTHER').slice(0,300),at:now()});persist(l,r);
  };
  const newEntry=(key,live,title,observed=[])=>({key,number:live.number,url:live.html_url||live.url||'',title,labels:[...observed.filter(l=>!l.startsWith('status:')),'status:triaged'],observedLabels:observed,status:'triaged',state:'open',history:[{status:'triaged',at:now(),by:config.agentLogin}],prs:[],mergeSha:null,deliveries:[],rollbacks:[]});
  // Install card contract: answered Q-N, question id 'install', full releaseSha on that
  // question, and its 'install' option selected by an explicit owner reply (not a standing order).
  const verifiedInstall=install=>{
    if(!install||typeof install.cardId!=='string'||!install.cardId||install.readbackPassed!==true||!SHA.test(install.releaseSha||''))return false;
    return store.readSets(run).some(s=>s.id===install.cardId&&s.status==='answered'&&['card','ui','numbered-reply'].includes(s.answeredVia)&&s.card?.questions?.some(q=>q.id==='install'&&q.releaseSha===install.releaseSha&&q.options?.some(a=>a.id==='install')&&s.answers?.[q.id]==='install'));
  };
  const closeCompleted=async(l,e)=>{
    const prod=e.deliveries.find(d=>d.target==='prod'&&!d.removed&&ancestor(e.mergeSha,d.sha)),install=e.install;
    const installed=verifiedInstall(install)&&ancestor(e.mergeSha,install.releaseSha);
    const harness=slug().split('/')[1].toLowerCase()==='trioharness-lean';
    if(!e.mergeSha||!(harness?(e.status==='released'&&installed):(e.status==='deployed-prod'&&prod)))refuse('CLOSE_BEFORE_DELIVERY');
    await labels(e,e.status);await api(`issues/${e.number}`,'PATCH',{state:'closed',state_reason:'completed'});e.state='closed';
  };

  async function adopt(o) {
    checkedRun(run);if(!Number.isSafeInteger(Number(o.issue))||Number(o.issue)<1)refuse('ISSUE_NUMBER_INVALID');const n=Number(o.issue);
    const lock=store.lock();if(!lock.ok)refuse(lock.code,{path:lock.path});
    try{
    const l=load(),existing=Object.values(l.issues).find(e=>e.number===n);
      if(existing){
        if(existing.source==='adopted'&&existing.adoptionComplete!==true){
          await runner();await labels(existing,'triaged');persist(l);
          ownCreated(await api(`issues/${n}/comments`,'POST',{body:`adopted by run ${run}`}));existing.adoptionComplete=true;persist(l);
        }
        return {ok:true,issue:existing};
      }
      for(const other of store.list())if(other!==run&&!store.finished(other)){const held=store.read(other);if(held?.repo===slug()&&Object.values(held.issues).some(e=>e.number===n))refuse('ISSUE_ALREADY_ADOPTED',{holdingRun:other});}
      const live=await api(`issues/${n}`),[title,body]=scan(live.title,live.body);
      if(live.pull_request)refuse('ISSUE_IS_PULL_REQUEST');if(live.state!=='open')refuse('ISSUE_NOT_OPEN');if(Buffer.byteLength(String(live.body||''),'utf8')>20480)refuse('ISSUE_TOO_LARGE');
      const call=await runner(),[owner,name]=slug().split('/');
      const q=await call(['api','graphql','-f','query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){author{login} editor{login} lastEditedAt}}}','-f',`owner=${owner}`,'-f',`name=${name}`,'-F',`number=${n}`]);
      if(!q.ok)refuse('GH_UNAVAILABLE');let meta;try{meta=JSON.parse(q.out).data.repository.issue;}catch{refuse('ISSUE_AUTHOR_UNTRUSTED');}
      const author=meta?.author?.login,editor=meta?.editor?.login;
      if(!LOGIN.test(author||'')||(editor!=null&&!LOGIN.test(editor)))refuse('ISSUE_AUTHOR_UNTRUSTED');
      const bodySha256=hash(String(live.body||''));let trust='owner-login';
      const code=!owners(author)?'ISSUE_AUTHOR_UNTRUSTED':editor&&!owners(editor)?'ISSUE_EDITED_BY_UNTRUSTED':null;
      if(code){
        if(o.cardSet){const set=store.readSets(run).find(s=>s.id===o.cardSet),question=set?.card?.questions?.find(q=>q.id==='adopt'&&q.issueNumber===n);
          if(!question||set.status!=='answered'||set.answers?.adopt!=='adopt')refuse('ISSUE_CARD_UNANSWERED');if(question.bodySha256!==bodySha256)refuse('ISSUE_CARD_STALE');trust=`owner-card:${o.cardSet}`;
        }else{
          l.refusals.push({number:n,author,code,rules:[]});persist(l);
          const card={questions:[{id:'adopt',header:'Adopt issue',question:`Adopt issue #${n} by ${author}: ${title.slice(0,100)} (body sha256 ${bodySha256})?`,why:'Issue text is untrusted task data.',recommended:'decline',issueNumber:n,bodySha256,options:[{id:'adopt',label:'Adopt',description:'Use this issue as the task source.'},{id:'decline',label:'Do not adopt',description:'Leave this issue unclaimed.'}]}]};
          validateCard(card);refuse(code,{card});
        }
      }
      const key=o.key||`issue-${n}`;checkedKey(key);if(Object.keys(l.issues).some(k=>k.toLowerCase()===key.toLowerCase()))refuse('ISSUE_KEY_COLLISION');
      const marker=randomUUID(),file=store.writeBody(run,n,`<untrusted id="${marker}">\n${body}\n</untrusted id="${marker}">\n`);
      const e=newEntry(key,live,title,names(live.labels));Object.assign(e,{source:'adopted',author,trust,bodySha256,file});
      l.issues[key]=e;persist(l);await labels(e,'triaged');persist(l);
      ownCreated(await api(`issues/${n}/comments`,'POST',{body:`adopted by run ${run}`}));e.adoptionComplete=true;persist(l);return {ok:true,issue:e};
    }finally{const released=store.unlock(lock);if(released?.code==='ADOPT_LOCK_NOT_OWNED')pending('adopt',o,{code:'ADOPT_LOCK_NOT_OWNED'});}
  }

  async function command(op,o={}) {
    if(op==='open'||op==='comment'||(op==='close'&&o.notPlanned)){
      const [title,body,reason]=scan(o.title,o.body??(o.bodyFile?readFileSync(o.bodyFile,'utf8'):''),o.reason);o={...o,title,body,reason};
    }
    if(op==='ensure-labels'){const r=await ensureLabels(await runner(),slug());if(!r.ok)refuse('GH_UNAVAILABLE',{safeError:r.error});return r;}
    if(op==='adopt')return adopt(o);
    if(op==='list'&&!run)return {ok:true,issues:(await paginated(`issues?state=${o.open?'open':'all'}&per_page=100`)).map(liveMetadata)};
    const l=load();
    if(op==='list')return {ok:true,ledger:o.open?{...l,issues:Object.fromEntries(Object.entries(l.issues).filter(([,e])=>!['deployed-prod','released','withdrawn'].includes(e.status)))}:l,...(o.live?{live:(await paginated(`issues?state=${o.open?'open':'all'}&per_page=100`)).map(liveMetadata)}:{})};
    if(op==='pr-refs')return {ok:true,refs:select(l,o).map(e=>`Refs #${e.number}`).join('\n')};
    if(op==='open'){
      checkedKey(o.key);const collision=Object.keys(l.issues).find(k=>k.toLowerCase()===o.key.toLowerCase());
      if(collision&&collision!==o.key)refuse('ISSUE_KEY_COLLISION');if(l.issues[o.key])return {ok:true,issue:l.issues[o.key]};await runner();
      const found=(await paginated('issues?state=all&per_page=100')).filter(e=>e.title===o.title&&!e.pull_request);if(found.length>1)refuse('ISSUE_TITLE_AMBIGUOUS');let live=found[0];
      if(live&&live.user?.login?.toLowerCase()!==config.agentLogin.toLowerCase())refuse('IDENTITY_MISMATCH');
      if(live?.state==='closed')refuse('ISSUE_TITLE_CLOSED');
      const result=await ensureLabels(await runner(),slug());if(!result.ok)refuse('GH_UNAVAILABLE',{safeError:result.error});
      const labelList=String(o.labels||'').split(',').filter(x=>x&&!x.startsWith('status:'));labelList.push('status:triaged');
      if(!live)live=ownCreated(await api('issues','POST',{title:o.title,body:o.body,labels:labelList}));
      if(!Number.isInteger(live.number)||live.number<1)refuse('GH_UNAVAILABLE');const e=newEntry(o.key,live,o.title,labelList);l.issues[o.key]=e;persist(l);return {ok:true,issue:e};
    }
    // Architect recovery: resolve-superseded --run <id> --pending-index <zero-based index>.
    // No caller-supplied status/reason/evidence can clear any other pending class.
    if(op==='resolve-superseded'){
      const value=String(o.pendingIndex),index=Number(value),p=l.pending[index];
      const keys=/^(0|[1-9][0-9]*)$/.test(value)&&Number.isSafeInteger(index)&&p&&!p.resolved?supersededStatus(l,p):null;
      if(!keys)refuse('SUPERSEDED_PENDING_INVALID');resolveSuperseded(l,p,keys);return {ok:true,index,reason:'superseded'};
    }
    if(op==='sync')return sync(o);
    checkedKey(o.key);const e=select(l,{key:o.key})[0];
    if(op==='set-status'){await runner();await status(l,e,o.status);persist(l);return {ok:true,issue:e};}
    if(op==='comment'){ownCreated(await api(`issues/${e.number}/comments`,'POST',{body:o.body}));return {ok:true};}
    if(op==='reopen')refuse('REOPEN_NEEDS_ROLLBACK');
    if(op==='close'){
      await runner();if(o.completed)await closeCompleted(l,e);
      else if(o.notPlanned){if(!o.reason)refuse('CLOSE_REASON_REQUIRED');await labels(e,'withdrawn',['wontfix']);ownCreated(await api(`issues/${e.number}/comments`,'POST',{body:o.reason}));await api(`issues/${e.number}`,'PATCH',{state:'closed',state_reason:'not_planned'});e.status='withdrawn';e.state='closed';e.history.push({status:'withdrawn',at:now(),by:config.agentLogin,reason:o.reason});}
      else refuse('CLOSE_REASON_REQUIRED');persist(l);return {ok:true,issue:e};
    }
    refuse('COMMAND_INVALID');
  }

  async function sync(o) {
    let l=load();const unresolved=[],selfPending=[],snapshotLength=l.pending.length;
    // Architect recovery: sync --run <id> --rollback-pending <zero-based index> --to-sha <SHA>.
    // Only the named rollback's target/keys/revision are replayed, with checked ancestry evidence.
    let rollbackIndex=null;
    if(o.rollbackPending!==undefined){
      const value=String(o.rollbackPending);rollbackIndex=Number(value);const p=l.pending[rollbackIndex];
      if(!/^(0|[1-9][0-9]*)$/.test(value)||!Number.isSafeInteger(rollbackIndex)||!p||p.resolved||p.op!=='transition'||p.args?.event!=='rollback'||p.error!=='ROLLBACK_UNRESOLVED'||!SHA.test(o.toSha||''))refuse('ROLLBACK_EVIDENCE_INVALID');
    }
    for(let i=0;i<snapshotLength;i++){
      const p=l.pending[i];if(p.resolved)continue;
      // Old candidates may already contain a sync entry: the outer refresh covers it.
      // Never invoke sync recursively, and leave it unresolved if that refresh fails.
      if(p.op==='sync'){selfPending.push(i);continue;}
      const superseded=supersededStatus(l,p);if(superseded){resolveSuperseded(l,p,superseded);l=load();continue;}
      const args=i===rollbackIndex?{...p.args,toSha:o.toSha}:p.args;
      const r=p.op==='transition'?await transition(args.event,args,{replay:true}):await execute(p.op,args,{replay:true});
      l=load();if(!r.ok){unresolved.push({index:i,code:r.code});continue;}
      l.pending[i].resolved={at:now(),...(i===rollbackIndex?{toSha:o.toSha}:{})};persist(l);
    }
    await runner();l=load();const drift=[],merged=[];
    for(const e of Object.values(l.issues)){
      if(e.status==='in-review')for(const ref of e.prs){const pr=await api(`pulls/${ref.number}`),tip=trusted().sha;if(pr.merged===true&&ancestor(pr.merge_commit_sha,tip)){e.mergeSha=pr.merge_commit_sha;await status(l,e,'merged',{internal:true,evidence:{pr:ref.number,mergeSha:e.mergeSha}});merged.push(e.key);break;}}
      const live=await api(`issues/${e.number}`);
      if(e.source==='adopted'&&live.state==='closed'&&e.state!=='closed'){
        const events=await paginated(`issues/${e.number}/events?per_page=100`),closed=events.filter(x=>x.event==='closed').at(-1);
        if(owners(closed?.actor?.login)){e.status='withdrawn';e.state='closed';e.history.push({status:'withdrawn',at:now(),by:closed.actor.login});await labels(e,'withdrawn');continue;}
        persist(l);return {ok:false,code:'ISSUES_OUT_OF_SYNC',exitCode:2};
      }
      const desired=[...new Set([...e.labels.filter(x=>!x.startsWith('status:')),...(e.status==='withdrawn'?['wontfix']:[`status:${e.status}`])])];
      if(JSON.stringify(names(live.labels).sort())!==JSON.stringify([...desired].sort())){
        drift.push(e.key);await api(`issues/${e.number}/labels`,'PUT',{labels:desired});e.labels=desired;
      }
      const expected=['deployed-prod','released','withdrawn'].includes(e.status)?'closed':'open';if(live.state!==expected){drift.push(e.key);persist(l);return {ok:false,code:'ISSUES_OUT_OF_SYNC',exitCode:2};}
    }
    for(const i of selfPending)l.pending[i].resolved={at:now(),reason:'sync-refreshed'};
    for(let i=snapshotLength;i<l.pending.length;i++)if(!l.pending[i].resolved)unresolved.push({index:i,code:'DEFERRED_TO_NEXT_SYNC'});
    persist(l);if(merged.length)resolveFailures(ledgerRoot,run,'merged',merged);return unresolved.length?{ok:false,code:'ISSUES_PENDING',exitCode:2,pending:unresolved,drift}:{ok:true,drift};
  }

  async function eventCommand(event,o,internal={}) {
    if(!ISSUE_EVENTS.includes(event))refuse('EVENT_INVALID');await runner();
    if(['writer-start','pr-open','merged','installed'].includes(event)){
      const l=load(),keylessMerge=event==='merged'&&['key','keys','issues'].every(k=>o[k]===undefined);
      // A keyless host observation covers registered PRs, not unrelated or withdrawn work.
      const selected=select(l,o).filter(e=>!keylessMerge||(e.status!=='withdrawn'&&e.prs.length>0));
      if(selected.some(e=>e.status==='withdrawn'))refuse('STATUS_WITHDRAWN');
      if(event==='pr-open'){
        if(!Number.isSafeInteger(Number(o.pr))||Number(o.pr)<1)refuse('PR_NUMBER_INVALID');
        const pr=await api(`pulls/${Number(o.pr)}`),commits=await paginated(`pulls/${Number(o.pr)}/commits?per_page=100`);scan(pr.body,...commits.map(c=>c.commit?.message));
        if(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+)/i.test([pr.body,...commits.map(c=>c.commit?.message)].join('\n')))refuse('AUTOCLOSE_KEYWORD');if(!SHA.test(pr.head?.sha||''))refuse('PR_HEAD_UNVERIFIED');
        for(const e of selected){if(!e.prs.some(p=>p.number===Number(o.pr)&&p.sha===pr.head.sha))e.prs.push({number:Number(o.pr),sha:pr.head.sha});await status(l,e,'in-review',{internal:true,evidence:{pr:Number(o.pr),sha:pr.head.sha}});}
      }else if(event==='merged'){
        if(keylessMerge&&!selected.length)return {ok:true,keys:[]};
        const tip=trusted().sha,provenKeys=[];
        for(const e of selected){
          // Replay and keyless observations reuse recorded proof without regressing later delivery.
          if((internal.replay||keylessMerge)&&SHA.test(e.mergeSha||'')&&STATUSES.indexOf(e.status)>=STATUSES.indexOf('merged')){provenKeys.push(e.key);continue;}
          let proven=false;
          for(const ref of e.prs){
            const pr=await api(`pulls/${ref.number}`);
            if(pr.merged===true&&ancestor(pr.merge_commit_sha,tip)){
              e.mergeSha=pr.merge_commit_sha;await status(l,e,'merged',{internal:true,evidence:{pr:ref.number,mergeSha:e.mergeSha}});proven=true;provenKeys.push(e.key);break;
            }
          }
          if(!proven&&!keylessMerge)refuse('MERGE_UNVERIFIED');
        }
        if(!provenKeys.length)refuse('MERGE_UNVERIFIED');
        persist(l);return {ok:true,keys:provenKeys};
      }else if(event==='installed'){
        if(slug().split('/')[1].toLowerCase()!=='trioharness-lean')refuse('INSTALL_REPO_INVALID');
        const evidence=typeof o.installEvidence==='string'?JSON.parse(readFileSync(o.installEvidence,'utf8')):null;
        if(!verifiedInstall(evidence)||selected.some(e=>!ancestor(e.mergeSha,evidence.releaseSha)))refuse('INSTALL_UNVERIFIED');
        for(const e of selected){if(!ancestor(e.mergeSha,evidence.releaseSha))refuse('INSTALL_UNVERIFIED');e.install={cardId:evidence.cardId,releaseSha:evidence.releaseSha,readbackPassed:true};await status(l,e,'released',{internal:true,evidence:{install:e.install}});await closeCompleted(l,e);}
      }else for(const e of selected){
        if(internal.replay&&STATUSES.indexOf(e.status)>=STATUSES.indexOf('in-progress'))continue;
        await status(l,e,'in-progress',{internal:true});
      }
      persist(l);return {ok:true,keys:selected.map(e=>e.key)};
    }
    const target=o.target||event.replace('deployed-','');if(!['qa','prod'].includes(target))return {ok:true,keys:[]};if(event!=='rollback'&&event!==`deployed-${target}`)refuse('DELIVERY_TARGET_MISMATCH');
    const all=store.list().map(r=>({run:r,ledger:store.read(r)})).filter(x=>x.ledger?.repo===slug());
    const timeline=all.flatMap(x=>Object.values(x.ledger.issues).flatMap(e=>e.deliveries.filter(d=>d.target===target&&!d.removed))).sort((a,b)=>String(a.at).localeCompare(String(b.at)));
    const anchor=timeline.findLastIndex(d=>d.revision&&d.revision===o.toRevision),changed=[];
    // Preflight every affected issue before any ledger or GitHub mutation: an unknown
    // ancestry in a later issue must not leave earlier issues regressed.
    const rollbackContains=new Map();
    if(event==='rollback')for(const rec of all)for(const e of Object.values(rec.ledger.issues)){
      if((o.key&&e.key!==o.key)||!e.mergeSha||e.status==='withdrawn'||!e.deliveries.some(d=>d.target===target&&!d.removed))continue;
      if(o.toSha!=null){const contains=ancestor(e.mergeSha,o.toSha);if(contains===null)refuse('ROLLBACK_UNRESOLVED');rollbackContains.set(e,contains);}
      else if(anchor<0)refuse('ROLLBACK_UNRESOLVED');
    }
    for(const rec of all){const l=rec.ledger;
      for(const e of Object.values(l.issues)){
        if(o.key&&e.key!==o.key)continue;if(!e.mergeSha||e.status==='withdrawn')continue;
        if(event!=='rollback'){
          if(e.state==='closed'||!ancestor(e.mergeSha,o.sha))continue;
          if(!e.deliveries.some(d=>!d.removed&&d.target===target&&d.sha===o.sha&&d.revision===o.revision))e.deliveries.push({target,sha:o.sha,revision:o.revision??null,at:now(),runId:run});
          const to=`deployed-${target}`;if(STATUSES.indexOf(to)>=STATUSES.indexOf(e.status))await status(l,e,to,{internal:true,evidence:{sha:o.sha,target}});if(target==='prod')await closeCompleted(l,e);changed.push(e.key);
        }else{
          const standing=e.deliveries.filter(d=>d.target===target&&!d.removed);if(!standing.length)continue;
          const deployedSha=e.deliveries.filter(d=>d.target===target).at(-1).sha,rollbackKey=hash([slug(),target,deployedSha,o.toSha??'',o.toRevision??''].join('|'));if(e.rollbacks.some(r=>r.key===rollbackKey))continue;
          if(o.toSha&&rollbackContains.get(e)===true)continue;
          const removed=standing.filter(d=>o.toSha?rollbackContains.get(e)===false:timeline.indexOf(d)>anchor);if(!removed.length)continue;
          for(const d of removed)d.removed={at:now(),rollbackKey};e.rollbacks.push({key:rollbackKey,target,deployedSha,toSha:o.toSha??null,toRevision:o.toRevision??null,at:now(),runId:run});
          const has=t=>e.deliveries.some(d=>d.target===t&&!d.removed),to=has('prod')?'deployed-prod':has('qa')?'deployed-qa':'merged';
          if(to!==e.status)await status(l,e,to,{internal:true,allowRegress:true,evidence:{rollbackKey}});if(!has('prod')&&e.state==='closed'){await api(`issues/${e.number}`,'PATCH',{state:'open'});e.state='open';}changed.push(e.key);
        }
      }
      persist(l,rec.run);
    }
    return {ok:true,keys:changed};
  }

  async function execute(op,o={},internal={}) {
    try{
      // Snapshot the scanned text itself for replay, rather than retaining a mutable file path.
      if(op==='open'||op==='comment'||(op==='close'&&o.notPlanned)){
        const [title,body,reason]=scan(o.title,o.body??(o.bodyFile?readFileSync(o.bodyFile,'utf8'):''),o.reason);o={...o,title,body,reason};
      }
      return await command(op,o);
    }catch(e){const code=e.code||'OTHER';
      if(['GH_UNAVAILABLE','IDENTITY_MISMATCH'].includes(code)&&['open','adopt','comment','set-status','close','ensure-labels'].includes(op)){if(!internal.replay)try{pending(op,o,e);}catch{}return {ok:false,code:'ISSUE_UPDATE_PENDING',exitCode:2,error:redactText(e.safeError||code).slice(0,300)};}
      return {ok:false,code,exitCode:2,...(e.rules?{rules:e.rules}:{}),...(e.path?{path:e.path}:{}),...(e.holdingRun?{holdingRun:e.holdingRun}:{}),...(e.defaultCode?{defaultCode:e.defaultCode}:{}),...(e.card?{card:e.card}:{})};
    }
  }
  async function transition(event,o={},internal={}) {
    try{const r=await eventCommand(event,o,internal);if(r.ok)resolveFailures(ledgerRoot,run,event,r.keys||[]);return r;}
    catch(e){
      const hook=internal.hook&&trackedHook(event);
      // A host discards this return value, so all tracked host refusals need durable evidence.
      // Failure records contain fixed fields only, including for secret/text refusals.
      if(hook)appendFailure({ledger:ledgerRoot,run,event,category:/^(IDENTITY_|DEFAULT_|REMOTE_)/.test(e.code||'')?'IDENTITY_UNVERIFIED':e.code==='GH_UNAVAILABLE'?'GH_UNAVAILABLE':'OTHER',key:o.key});
      if(e.code==='ISSUE_TEXT_SECRET')return {ok:false,code:e.code,rules:e.rules,exitCode:2};
      if(!internal.replay&&(hook||(!internal.hook&&['GH_UNAVAILABLE','IDENTITY_MISMATCH','ROLLBACK_UNRESOLVED'].includes(e.code))))try{pending('transition',{...o,event},e);}catch{if(!hook)appendFailure({ledger:ledgerRoot,run,event,category:'OTHER',key:o.key});}
      return {ok:false,code:['GH_UNAVAILABLE','IDENTITY_MISMATCH'].includes(e.code)?'ISSUE_UPDATE_PENDING':e.code||'OTHER',exitCode:2};
    }
  }
  return {execute,transition};
}

export async function transitionForEvent(event,opts={}) {
  try{return await createIssues(opts).transition(event,opts,{hook:true});}
  catch{appendFailure({ledger:opts.ledger,run:opts.run,event,category:'RUNNER_FAILED',key:opts.key});return {ok:false,code:'ISSUE_UPDATE_PENDING',exitCode:2};}
}

export async function main(argv=process.argv.slice(2)) {
  const o={},op=argv[0];for(let i=1;i<argv.length;i++)if(argv[i].startsWith('--')){const key=argv[i].slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase());o[key]=argv[i+1]&&!argv[i+1].startsWith('--')?argv[++i]:true;}
  try{
    const context=Object.fromEntries(['checkout','ledger','repo','run','remote'].filter(k=>o[k]!==undefined).map(k=>[k,o[k]]));
    const ctx=createIssues(context),r=op==='transition'?await ctx.transition(o.event,o):await ctx.execute(op,o);
    if(r.ok){process.stdout.write(r.refs!==undefined?`${r.refs}\n`:`${JSON.stringify(r,(key,value)=>key==='body'?'[body omitted]':value)}\n`);return 0;}
    const {error,...safe}=r;process.stderr.write(`${JSON.stringify(safe)}\n`);return 2;
  }
  catch{process.stderr.write('ISSUES_FAILED\n');return 2;}
}
if(isMain(import.meta.url))main().then(code=>{process.exitCode=code;});
