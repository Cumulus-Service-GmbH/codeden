import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, symlinkSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { LABELS, BACKFILL_KEYS, makeAgentGh, ensureLabels, createIssues, createFileStore, assertLedgerGrowth, acquireAdoptLock, releaseAdoptLock, transitionForEvent } from './issues.mjs';
import { appendFailure } from './issues-failure-log.mjs';
import { issueLedgerReason } from './clean-state.mjs';

const slug='org/project', sha='a'.repeat(40), bot='worker[bot]', owner='Maintainer';
const config={version:1,repo:slug,agentLogin:bot,ownerLogins:[owner]};
const hash=s=>createHash('sha256').update(s).digest('hex');
const clone=x=>structuredClone(x);
const root=()=>realpathSync(mkdtempSync(join(tmpdir(),'issues-test-')));
const secret=()=>['gh','p_', 'x'.repeat(36)].join('');
const ok=x=>({ok:true,out:JSON.stringify(x),err:''});
const entry=(extra={})=>({key:'d2',number:12,url:'https://github.com/org/project/issues/12',title:'Defect',labels:['harness-defect','status:triaged'],observedLabels:[],status:'triaged',history:[],prs:[],mergeSha:null,deliveries:[],rollbacks:[],...extra});
const ledger=(issues={})=>({version:1,repo:slug,issues,pending:[],refusals:[]});
function memory(initial={run:ledger()}) {
  const data=clone(initial), bodies={}, cards=[];
  return {data,bodies,cards,read:r=>clone(data[r]??null),write(r,l){assertLedgerGrowth(data[r],l);data[r]=clone(l);},list:()=>Object.keys(data),finished:()=>false,writeBody(r,n,s){const p=`${r}/issue-${n}.md`;if(p in bodies) throw new Error('EEXIST');bodies[p]=s;return p;},readSets:()=>cards,lock:()=>({ok:true,token:'memory'}),unlock:()=>true};
}
function fixture(extra={}, initial=ledger({d2:entry()})) {
  const calls=[],store=memory({run:initial});
  let live={number:12,html_url:entry().url,title:'Defect',body:'Evidence line',state:'open',user:{login:owner},labels:[]};
  const gh=async(args,input)=>{
    calls.push({args,input}); const p=args[1]?.split('?')[0], method=args[args.indexOf('-X')+1];
    if(p==='graphql') return ok({data:{repository:{issue:{author:{login:live.user.login},editor:null,lastEditedAt:null}}}});
    if(p?.endsWith('/labels') && !args.includes('-X')) return ok(LABELS);
    if(p?.endsWith('/commits')) return ok([]);
    if(p?.includes('/pulls/')) return ok({number:2,body:'Refs #12',head:{sha},merged:true,merge_commit_sha:sha});
    if(p?.endsWith('/events')) return ok([{event:'closed',actor:{login:owner}}]);
    if(args[1]?.includes('/issues?')) return ok([]);
    if(p?.endsWith('/comments') && method==='POST') return ok({user:{login:bot}});
    if(p?.endsWith('/issues') && method==='POST') return ok({...live,user:{login:bot}});
    return ok(live);
  };
  const ctx=createIssues({repo:slug,checkout:root(),ledger:root(),run:'run',gh,config,store,git:()=>'',trustedDefault:()=>({sha}),ancestor:()=>true,...extra});
  return {ctx,store,calls,setLive:x=>{live={...live,...x};},execute:(op,o={})=>ctx.execute(op,{key:'d2',...o}),transition:(event,o={})=>ctx.transition(event,{key:'d2',...o})};
}
async function refused(fn) {try {const r=await fn();return r?.code??'NO_REFUSAL';}catch(e){return e.code??e.message.split(':')[0];}}
const writes=calls=>calls.filter(c=>c.args.includes('-X'));
function identity(overrides={}) {
  const dir=root(), ghdir=join(dir,'agent');mkdirSync(ghdir);
  const calls=[],gitCalls=[];
  const git=(args)=>{gitCalls.push(args);if(args[0]==='remote'&&args.length===1)return 'origin\n';if(args[0]==='ls-remote')return `ref: refs/heads/release\tHEAD\n${sha}\tHEAD\n`;if(args[0]==='rev-parse')return sha;if(args[0]==='show')return JSON.stringify(config);if(args[0]==='remote')return 'https://github.com/org/project.git';return '';};
  return {calls,gitCalls,opts:{checkout:dir,repo:slug,env:{HOME:dir,GH_CONFIG_DIR:ghdir},git,spawn:(args,input,options)=>{calls.push({args,input,options});return ok(args[1]==='graphql'?{data:{viewer:{login:bot}}}:[]);},...overrides}};
}
const d=(area,n,fn)=>test(`hf5b1e-s6-d-${area}-${String(n).padStart(2,'0')}`,fn);

d('label',1,async()=>{const known=LABELS.slice(0,16).map(clone),calls=[];const gh=async(a,i)=>{calls.push(a);if(!a.includes('-X'))return ok(known);known.push(JSON.parse(i));return ok({});};const a=await ensureLabels(gh,slug),count=calls.filter(a=>a.includes('POST')).length;await ensureLabels(gh,slug);assert.ok(a.ok&&count===4&&calls.filter(a=>a.includes('POST')).length===4);});
d('label',2,async()=>{const calls=[];const r=await ensureLabels(async a=>{calls.push(a);return ok(LABELS.map(l=>({...l,color:'000000'})));},slug);assert.ok(r.ok&&r.drift?.length&&calls.every(a=>!a.includes('-X')));const collision=await ensureLabels(async a=>a.includes('-X')?{ok:false,out:'',err:'HTTP 422 already_exists'}:ok([]),slug);const bad=await ensureLabels(async a=>a.includes('-X')?{ok:false,out:'',err:'HTTP 422 invalid color'}:ok([]),slug);assert.ok(collision.ok&&!bad.ok);});
d('ident',1,async()=>{const f=identity();const a=await refused(()=>makeAgentGh({...f.opts,env:{}}));const b=await refused(()=>makeAgentGh({...f.opts,git:a=>a[0]==='show'?'':f.opts.git(a)}));assert.deepEqual([a,b],['IDENTITY_NOT_CONFIGURED','IDENTITY_NOT_CONFIGURED']);});
d('ident',2,async()=>{const f=identity();assert.equal(await refused(()=>makeAgentGh({...f.opts,git:()=>{throw new Error('offline');}})),'IDENTITY_CONFIG_UNTRUSTED');});
d('ident',3,async()=>{const f=identity();const a=await refused(()=>makeAgentGh({...f.opts,repo:'other/project'}));const b=await refused(()=>makeAgentGh({...f.opts,git:a=>a[0]==='remote'&&a.length>1?'https://github.com/other/project.git':f.opts.git(a)}));assert.deepEqual([a,b],['IDENTITY_CONFIG_REPO_MISMATCH','IDENTITY_CONFIG_REPO_MISMATCH']);});
d('ident',4,async()=>{const f=identity(),def=join(f.opts.env.HOME,'.config','gh');mkdirSync(def,{recursive:true});const link=join(f.opts.env.HOME,'link');symlinkSync(def,link);const a=await refused(()=>makeAgentGh({...f.opts,env:{...f.opts.env,GH_CONFIG_DIR:def}}));const b=await refused(()=>makeAgentGh({...f.opts,env:{...f.opts.env,GH_CONFIG_DIR:link}}));assert.deepEqual([a,b],['IDENTITY_IS_DEFAULT_GH_DIR','IDENTITY_IS_DEFAULT_GH_DIR']);});
d('ident',5,async()=>{const got=[];for(const response of [ok({data:{viewer:{login:'stranger'}}}),ok({data:{viewer:{login:owner}}}),{ok:false,out:'',err:'offline'},ok({})]){const f=identity();got.push(await refused(async()=>{const gh=await makeAgentGh({...f.opts,spawn:()=>response});return gh(['api','repos/org/project/issues','-X','POST']);}));assert.equal(writes(f.calls).length,0);}assert.deepEqual(got,['IDENTITY_MISMATCH','IDENTITY_IS_OWNER','IDENTITY_UNVERIFIED','IDENTITY_UNVERIFIED']);});
d('ident',6,async()=>{const f=identity();await makeAgentGh(f.opts);assert.ok(f.gitCalls.some(a=>a[0]==='show'&&a[1]===`${sha}:.trioharness/issues.json`));});
d('ident',7,async()=>{const f=identity();const gh=await makeAgentGh(f.opts);await gh(['api','repos/org/project/labels']);assert.ok(f.calls.length===2&&f.calls[0].args[1]==='graphql'&&f.calls[0].args.join(' ').includes('viewer{login}')&&!f.calls.some(c=>c.args[1]==='/user'));});
d('ident',8,async()=>{const f=fixture({gh:async a=>a[1].endsWith('/labels')?ok(LABELS):a.includes('POST')?ok({number:13,user:{login:'stranger'}}):ok([])},ledger());const r=await f.execute('open',{title:'new',body:'safe'});assert.ok(r.code==='ISSUE_UPDATE_PENDING'&&f.store.data.run.pending.length===1&&!f.store.data.run.issues.d2);});
d('runner',1,async()=>{const f=identity();for(const k of ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GH_HOST','GH_REPO'])f.opts.env[k]='sentinel';const before=clone(process.env),gh=await makeAgentGh(f.opts);await gh(['api','repos/org/project/labels']);assert.ok(f.calls.length===2&&f.calls.every(c=>['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GITHUB_ENTERPRISE_TOKEN','GH_HOST','GH_REPO'].every(k=>!(k in c.options.env))&&c.options.env.GH_CONFIG_DIR===f.opts.env.GH_CONFIG_DIR&&c.options.env.GH_PROMPT_DISABLED==='1'));assert.deepEqual({...process.env},before);});
d('runner',2,()=>{const text=readFileSync(new URL('./issues.mjs',import.meta.url),'utf8'),start=text.indexOf('export async function makeAgentGh('),end=text.indexOf('\nexport ',start+1),rest=text.slice(0,start)+text.slice(end);assert.ok(start>=0&&text.includes('ghCli(')&&!/(?:ghCli\s*\(|defaultGh|ghJsonRunner)/.test(rest));});
d('secret',1,async()=>{for(const op of ['open','comment','close','adopt']){const f=fixture({},op==='adopt'?ledger():ledger({d2:entry()}));if(op==='adopt')f.setLive({title:secret()});const before=clone(f.store.data);const r=await f.execute(op,{title:secret(),body:secret(),reason:secret(),notPlanned:true,issue:12});assert.ok(r.code==='ISSUE_TEXT_SECRET'&&writes(f.calls).length===0&&JSON.stringify(f.store.data)===JSON.stringify(before)&&Object.keys(f.store.bodies).length===0&&!JSON.stringify(r).includes(secret()));}});
d('secret',2,async()=>{const f=fixture({gh:async()=>({ok:false,out:'',err:secret()})});const r=await f.execute('comment',{body:'Safe'});assert.ok(r.code==='ISSUE_UPDATE_PENDING'&&f.store.data.run.pending.length===1&&!JSON.stringify([r,f.store.data]).includes(secret())&&f.store.data.run.pending[0].error.includes('REDACTED'));});
d('secret',3,async()=>{const f=fixture({gh:async()=>({ok:false,out:'',err:'offline'})});await f.execute('comment',{body:'safe evidence'});const before=clone(f.store.data);const r=await f.execute('comment',{body:secret()});assert.ok(before.run.pending[0]?.args?.body==='safe evidence'&&r.code==='ISSUE_TEXT_SECRET'&&JSON.stringify(f.store.data)===JSON.stringify(before));const bodyFile=join(root(),'body.md');writeFileSync(bodyFile,'original safe text');const g=fixture({gh:async()=>({ok:false,out:'',err:'offline'})},ledger());await g.execute('open',{title:'new',bodyFile});writeFileSync(bodyFile,'edited after failure');assert.equal(g.store.data.run.pending[0].args.body,'original safe text');assert.ok(!('bodyFile'in g.store.data.run.pending[0].args));});
d('status',1,async()=>{const f=fixture();f.setLive({labels:[{name:'security'},{name:'status:merged'},{name:'status:triaged'}]});const r=await f.execute('set-status',{status:'in-progress'});const puts=writes(f.calls).filter(c=>c.args.includes('PUT'));assert.ok(r.ok&&puts.length===1&&JSON.parse(puts[0].input).labels.filter(x=>x.startsWith('status:')).join()==='status:in-progress'&&JSON.parse(puts[0].input).labels.includes('security'));});
d('status',2,async()=>{const f=fixture({},ledger({d2:entry({status:'in-review'})}));const r=await f.execute('set-status',{status:'in-progress',allowRegress:true});assert.ok(r.code==='STATUS_REGRESSION'&&writes(f.calls).length===0);});
d('status',3,async()=>{const codes=[];for(const status of ['merged','deployed-qa','deployed-prod','released'])codes.push((await fixture().execute('set-status',{status,evidence:'trust me'})).code);assert.deepEqual(codes,Array(4).fill('STATUS_NEEDS_PROOF'));});
d('status',4,async()=>{const f=fixture({},ledger({d2:entry({status:'released'})}));f.setLive({labels:[{name:'status:released'}]});assert.equal((await f.execute('close',{completed:true})).code,'CLOSE_BEFORE_DELIVERY');});
d('status',5,async()=>{const f=fixture();const r=await f.execute('close',{notPlanned:true,reason:'Documented limit'});const calls=writes(f.calls);assert.ok(r.ok&&calls.some(c=>c.args.includes('PATCH')&&JSON.parse(c.input).state_reason==='not_planned')&&calls.some(c=>c.args[1].endsWith('/comments')&&JSON.parse(c.input).body==='Documented limit')&&f.store.data.run.issues.d2.labels.includes('wontfix'));});
d('pending',1,async()=>{const f=fixture({gh:async()=>({ok:false,out:'',err:'offline'})});const r=await f.execute('comment',{body:'evidence'});assert.ok(r.code==='ISSUE_UPDATE_PENDING'&&r.exitCode===2&&f.store.data.run.pending.length===1);});
d('pending',2,async()=>{let down=true;const f=fixture({gh:async(a)=>down?{ok:false,err:'offline',out:''}:ok(a[1].endsWith('/comments')?{user:{login:bot}}:{state:'open',labels:['status:triaged']})});await f.execute('comment',{body:'evidence'});down=false;const r=await f.execute('sync');assert.ok(r.ok&&f.store.data.run.pending.length===1&&f.store.data.run.pending[0].resolved);});
d('pending',3,async()=>{const dir=root(),remote=join(dir,'remote.git'),repo=join(dir,'repo');execFileSync('git',['init','--bare',remote],{stdio:'pipe'});execFileSync('git',['clone',remote,repo],{stdio:'pipe'});const git=a=>execFileSync('git',a,{cwd:repo,encoding:'utf8',stdio:'pipe'});writeFileSync(join(repo,'file'),'one');git(['add','.']);git(['commit','-m','first']);git(['push','origin','HEAD:main']);execFileSync('git',['symbolic-ref','HEAD','refs/heads/main'],{cwd:remote});git(['fetch','origin']);const tip=git(['rev-parse','HEAD']).trim();const initial=ledger({d2:entry({status:'in-review',prs:[{number:2,sha:tip}]})});const f=fixture({checkout:repo,git,trustedDefault:undefined,ancestor:undefined,gh:async a=>a[1].includes('/pulls/')?ok({merged:true,merge_commit_sha:tip}):ok({state:'open',labels:['status:merged']})},initial);const r=await f.execute('sync');assert.ok(r.ok&&f.store.data.run.issues.d2.status==='merged'&&f.store.data.run.issues.d2.mergeSha===tip);const g=fixture({ancestor:()=>false},initial);await g.execute('sync');assert.equal(g.store.data.run.issues.d2.status,'in-review');});
d('pr',1,async()=>{const got=[];for(const commits of [false,true]){const f=fixture({gh:async a=>ok(a[1].split('?')[0].endsWith('/commits')?[{commit:{message:'Fixes #12'}}]:{body:commits?'Refs #12':'Fixes org/project#12',head:{sha}})});got.push((await f.transition('pr-open',{pr:2})).code);assert.equal(writes(f.calls).length,0);}assert.deepEqual(got,['AUTOCLOSE_KEYWORD','AUTOCLOSE_KEYWORD']);});
d('key',1,async()=>{const f=fixture();const a=await f.execute('open',{key:'a/b',title:'x',body:'x'}),b=await f.execute('open',{key:'D2',title:'x',body:'x'});assert.ok(BACKFILL_KEYS.length===23&&BACKFILL_KEYS.every(k=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(k))&&new Set(BACKFILL_KEYS.map(k=>k.toLowerCase())).size===23&&a.code==='ISSUE_KEY_INVALID'&&b.code==='ISSUE_KEY_COLLISION');});
d('adopt',1,async()=>{const f=fixture({},ledger());const r=await f.execute('adopt',{issue:12});assert.ok(r.ok&&Object.values(f.store.data.run.issues)[0].trust==='owner-login');});
d('adopt',2,async()=>{const f=fixture({},ledger());f.setLive({user:{login:'outsider'}});const r=await f.execute('adopt',{issue:12});assert.ok(r.code==='ISSUE_AUTHOR_UNTRUSTED'&&f.store.data.run.refusals.length===1&&writes(f.calls).length===0);});
d('adopt',3,async()=>{const f=fixture({gh:async a=>a[1]==='graphql'?ok({data:{repository:{issue:{author:{login:owner},editor:{login:'outsider'},lastEditedAt:'2026-01-01'}}}}):ok({number:12,state:'open',title:'x',body:'safe',user:{login:owner},labels:[]})},ledger());assert.equal((await f.execute('adopt',{issue:12})).code,'ISSUE_EDITED_BY_UNTRUSTED');});
d('adopt',4,async()=>{const f=fixture({},ledger());f.setLive({body:secret(),user:{login:'outsider'}});const r=await f.execute('adopt',{issue:12});assert.ok(r.code==='ISSUE_TEXT_SECRET'&&f.store.data.run.refusals.length===0&&f.store.cards.length===0&&Object.keys(f.store.bodies).length===0&&!JSON.stringify(r).includes(secret()));});
d('adopt',5,async()=>{const f=fixture({},ledger());const r=await f.execute('adopt',{issue:12});const body=Object.values(f.store.bodies)[0]??'';assert.ok(r.ok&&/^<untrusted id="[^"]+">\nEvidence line\n<\/untrusted id="[^"]+">\n$/.test(body)&&!JSON.stringify(r).includes('Evidence line'));});
d('adopt',6,async()=>{const f=fixture({},ledger());f.setLive({labels:[{name:'status:released'},{name:'status:deployed-prod'}]});await f.execute('adopt',{issue:12});const e=Object.values(f.store.data.run.issues)[0];assert.ok(e?.status==='triaged'&&e.observedLabels.length===2&&(await f.execute('close',{key:e.key,completed:true})).code==='CLOSE_BEFORE_DELIVERY');});
d('adopt',7,async()=>{const f=fixture({},ledger());f.setLive({labels:[{name:'status:released'},{name:'status:in-review'},{name:'security'}]});const r=await f.execute('adopt',{issue:12});const puts=writes(f.calls).filter(c=>c.args.includes('PUT'));assert.ok(r.ok&&puts.length===1&&JSON.parse(puts[0].input).labels.join()==='security,status:triaged');});
d('adopt',8,async()=>{const f=fixture({},ledger());const a=await f.execute('adopt',{issue:12}),count=f.calls.length,b=await f.execute('adopt',{issue:12});assert.ok(a.ok&&b.ok&&f.calls.length===count&&Object.keys(f.store.bodies).length===1&&writes(f.calls).filter(c=>c.args[1].endsWith('/comments')).length===1);let fail=true,comments=0;const g=fixture({gh:async(a)=>a[1]==='graphql'?ok({data:{repository:{issue:{author:{login:owner},editor:null,lastEditedAt:null}}}}):a[1].endsWith('/comments')?(comments++,fail?{ok:false,out:'',err:'offline'}:ok({user:{login:bot}})):ok({number:12,state:'open',title:'Task',body:'safe',user:{login:owner},labels:[]})},ledger());const pending=await g.execute('adopt',{issue:12});fail=false;const replay=await g.execute('sync');assert.ok(pending.code==='ISSUE_UPDATE_PENDING'&&replay.ok&&comments===2&&g.store.data.run.pending[0].resolved&&Object.keys(g.store.bodies).length===1);});
d('adopt',9,async()=>{const f=fixture({},ledger());f.setLive({user:{login:'outsider'}});f.store.cards.push({id:'Q-1',status:'answered',card:{questions:[{id:'adopt',issueNumber:12,bodySha256:hash('Evidence line')}]},answers:{adopt:'adopt'}});const r=await f.execute('adopt',{issue:12,cardSet:'Q-1'});const g=fixture({},ledger());g.setLive({user:{login:'outsider'},body:'changed'});g.store.cards.push(...f.store.cards);const bad=await g.execute('adopt',{issue:12,cardSet:'Q-1'});assert.ok(r.ok&&Object.values(f.store.data.run.issues)[0].trust==='owner-card:Q-1'&&bad.code==='ISSUE_CARD_STALE');});
d('adopt',10,async()=>{const got=[];for(const x of [{pull_request:{}},{state:'closed'}]){const f=fixture({},ledger());f.setLive(x);got.push((await f.execute('adopt',{issue:12})).code);}assert.deepEqual(got,['ISSUE_IS_PULL_REQUEST','ISSUE_NOT_OPEN']);});
d('adopt',11,async()=>{const f=fixture({},ledger());await f.execute('adopt',{issue:12});const q=f.calls.find(c=>c.args[1]==='graphql');assert.ok(q&&q.args.includes('owner=org')&&q.args.includes('name=project')&&q.args.includes('number=12')&&!q.args.find(a=>a.startsWith('query=')).includes('org'));});
d('adopt',12,async()=>{const f=fixture({},ledger());await f.execute('adopt',{issue:12});const c=writes(f.calls).find(c=>c.args[1].endsWith('/comments'));assert.ok(c&&JSON.parse(c.input).body==='adopted by run run');});
d('adopt',13,async()=>{const f=fixture({},ledger({d2:entry({source:'adopted',author:owner})}));f.setLive({state:'closed'});const a=await f.execute('sync');const g=fixture({gh:async a=>ok(a[1].split('?')[0].endsWith('/events')?[{event:'closed',actor:{login:'outsider'}}]:{state:'closed',labels:['status:triaged']})},ledger({d2:entry({source:'adopted'})}));const b=await g.execute('sync');assert.ok(a.ok&&f.store.data.run.issues.d2.status==='withdrawn'&&b.code==='ISSUES_OUT_OF_SYNC');});
const delivered=(target,revision='new',s=sha)=>({target,revision,sha:s,at:'2026-01-01',runId:'run'});
function rollFixture(extra={},over={}){return fixture({ancestor:()=>false,...extra},ledger({d2:entry({status:'deployed-prod',state:'closed',mergeSha:sha,deliveries:[delivered('qa'),delivered('prod')],...over})}));}
d('roll',1,async()=>{const f=rollFixture();const r=await f.transition('rollback',{target:'qa',toSha:'b'.repeat(40),toRevision:'old'});const e=f.store.data.run.issues.d2;assert.ok(r.ok&&e.status==='deployed-prod'&&e.state==='closed'&&e.deliveries[0].removed&&!e.deliveries[1].removed&&!writes(f.calls).some(c=>c.args.includes('PATCH')));});
d('roll',2,async()=>{for(const qa of [true,false]){const f=rollFixture({},qa?{}:{deliveries:[delivered('prod')]});const r=await f.transition('rollback',{target:'prod',toSha:'b'.repeat(40),toRevision:'old'});const e=f.store.data.run.issues.d2;assert.ok(r.ok&&e.status===(qa?'deployed-qa':'merged')&&e.state==='open'&&writes(f.calls).some(c=>c.args.includes('PATCH')&&JSON.parse(c.input).state==='open'));}});
d('roll',3,async()=>{const f=rollFixture({ancestor:()=>true});const r=await f.transition('rollback',{target:'prod',toSha:sha});assert.ok(r.ok&&!f.store.data.run.issues.d2.deliveries.some(x=>x.removed)&&f.store.data.run.issues.d2.status==='deployed-prod');});
d('roll',4,async()=>{const f=rollFixture({}, {deliveries:[delivered('prod','old','b'.repeat(40)),delivered('prod','new')]});const r=await f.transition('rollback',{target:'prod',toSha:null,toRevision:'old'});const e=f.store.data.run.issues.d2;assert.ok(r.ok&&!e.deliveries[0].removed&&e.deliveries[1].removed);});
d('roll',5,async()=>{const f=rollFixture();const r=await f.transition('rollback',{target:'prod',toSha:null,toRevision:'unknown'});assert.ok(r.code==='ROLLBACK_UNRESOLVED'&&f.store.data.run.pending.length===1&&!f.store.data.run.issues.d2.deliveries.some(x=>x.removed));});
d('roll',6,async()=>{const f=rollFixture();f.store.data.other=ledger({d2:entry({mergeSha:sha,status:'deployed-prod',deliveries:[delivered('prod')]})});f.store.data.other.repo='another/repo';const before=clone(f.store.data.other);const ignored=await f.transition('rollback',{target:'staging',toSha:'b'.repeat(40)});assert.ok(ignored.ok&&!f.store.data.run.issues.d2.deliveries.some(x=>x.removed));const r=await f.transition('rollback',{target:'prod',toSha:'b'.repeat(40)});assert.ok(r.ok&&JSON.stringify(f.store.data.other)===JSON.stringify(before)&&f.store.data.run.issues.d2.deliveries[1].removed);});
d('roll',7,async()=>{const f=rollFixture();const o={target:'prod',toSha:'b'.repeat(40),toRevision:'old'};const a=await f.transition('rollback',o),b=await f.transition('rollback',o);assert.ok(a.ok&&b.ok&&f.store.data.run.issues.d2.rollbacks.length===1);const g=rollFixture({}, {deliveries:[delivered('prod','older','c'.repeat(40)),delivered('prod','new')]});const revision={target:'prod',toSha:null,toRevision:'older'};await g.transition('rollback',revision);const snapshot=JSON.stringify(g.store.data.run.issues);await g.transition('rollback',revision);assert.equal(JSON.stringify(g.store.data.run.issues),snapshot);});
d('deploy',1,async()=>{const f=fixture({ancestor:(a,b)=>a===sha&&b==='b'.repeat(40)},ledger({d2:entry({status:'merged',mergeSha:sha}),d3:entry({key:'d3',number:13,status:'merged',mergeSha:'c'.repeat(40)})}));f.store.data.other=ledger({x:entry({key:'x',mergeSha:sha})});f.store.data.other.repo='other/repo';const r=await f.ctx.transition('deployed-qa',{target:'qa',sha:'b'.repeat(40),revision:'r1'});assert.ok(r.ok&&f.store.data.run.issues.d2.status==='deployed-qa'&&f.store.data.run.issues.d3.status==='merged'&&f.store.data.other.issues.x.status==='triaged');const checkout=root();const helper=await transitionForEvent('deployed-qa',{repo:checkout,ledger:root(),run:'run',target:'qa',sha:'b'.repeat(40),revision:'r2',store:f.store,gh:async()=>ok({state:'open',labels:[]}),config,git:()=>`https://github.com/${slug}.git`,ancestor:()=>true});assert.ok(helper.ok);const silent=await transitionForEvent('writer-start',{repo:slug,ledger:root(),run:'run',key:'d2',store:memory(),gh:()=>{throw new Error(secret());},config});assert.ok(!silent.ok&&!JSON.stringify(silent).includes(secret()));});

function disk(){const repo=root(),store=createFileStore(repo);const dir=join(repo,'.trioharness-direct','runs','run');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'state.json'),'{}');return {repo,store,dir};}
d('ledger',1,async()=>{const f=disk(),base=fixture({store:f.store,ledger:f.repo},ledger());const a=await base.execute('open',{title:'Defect',body:'safe'}),b=await base.execute('open',{title:'Defect',body:'safe'});const text=existsSync(join(f.dir,'issues.json'))?JSON.parse(readFileSync(join(f.dir,'issues.json'),'utf8')):null;assert.ok(a.ok&&b.ok&&Object.keys(text?.issues??{}).length===1&&text.issues.d2.history.length===1&&writes(base.calls).filter(c=>c.args[1].endsWith('/issues')).length===1);});
d('ledger',2,()=>{const f=disk(),l=ledger({d2:entry({history:[{}],deliveries:[{}],rollbacks:[{}]})});f.store.write('run',l);const codes=[];for(const field of ['key','history','deliveries','rollbacks']){const n=clone(l);if(field==='key')delete n.issues.d2;else n.issues.d2[field]=[];try{f.store.write('run',n);codes.push('accepted');}catch(e){codes.push(e.code??e.message);}}assert.deepEqual(codes,Array(4).fill('LEDGER_SHRINK'));});
d('ledger',3,()=>{const f=disk(),file=join(f.dir,'issues.json');f.store.write('run',ledger());assert.ok(existsSync(file));const before=readFileSync(file,'utf8');let observed=false;const store=createFileStore(f.repo,{beforeSave:(path,next)=>{observed=readFileSync(path,'utf8')===before&&next.issues.d2?.number===12;}});store.write('run',ledger({d2:entry()}));assert.ok(observed&&JSON.parse(readFileSync(file,'utf8')).issues.d2.number===12);});
d('ledger',4,async()=>{const f=disk();f.store.write('run',ledger({d2:entry()}));appendFailure({ledger:f.repo,run:'run',event:'writer-start',category:'GH_UNAVAILABLE',key:'d2'});const path=join(f.dir,'issues-failures.jsonl'),before=readFileSync(path,'utf8');const g=fixture({ledger:f.repo,store:f.store});const r=await g.transition('writer-start');const after=readFileSync(path,'utf8');assert.ok(r.ok&&after.startsWith(before)&&after.length>before.length&&JSON.parse(after.trim().split('\n').at(-1)).kind==='resolved');});
d('failrec',1,async()=>{const f=disk();f.store.write('run',ledger({d2:entry(),d3:entry({key:'d3',number:13})}));appendFailure({ledger:f.repo,run:'run',event:'writer-start',category:'IMPORT_FAILED',key:'d2'});const g=fixture({ledger:f.repo,store:f.store});await g.transition('writer-start',{key:'d3'});const still=issueLedgerReason(f.repo,'run');await g.transition('writer-start');assert.ok(still?.startsWith('ISSUES_HOOK_FAILED')&&issueLedgerReason(f.repo,'run')===null);});
d('lock',1,async()=>{const f=disk(),path=join(f.repo,'.trioharness-direct','issues.lock');writeFileSync(path,'foreign');const g=fixture({ledger:f.repo,store:f.store});const r=await g.execute('adopt',{issue:12});assert.ok(r.code==='ADOPT_LOCKED'&&r.path===path&&readFileSync(path,'utf8')==='foreign');});
d('lock',2,()=>{const f=disk(),path=join(f.repo,'.trioharness-direct','issues.lock'),text=JSON.stringify({token:'old',pid:99999999,host:'gone',startedAt:'1990-01-01'});writeFileSync(path,text);const a=acquireAdoptLock(f.repo),b=acquireAdoptLock(f.repo);assert.ok(a.code==='ADOPT_LOCKED'&&b.code==='ADOPT_LOCKED'&&readFileSync(path,'utf8')===text);});
d('lock',3,()=>{const f=disk(),a=acquireAdoptLock(f.repo),path=join(f.repo,'.trioharness-direct','issues.lock');if(a.ok)writeFileSync(path,JSON.stringify({token:'foreign'}));const r=releaseAdoptLock(a);assert.ok(a.ok&&r.code==='ADOPT_LOCK_NOT_OWNED'&&readFileSync(path,'utf8')===JSON.stringify({token:'foreign'}));});
d('lock',4,()=>{const f=disk(),a=acquireAdoptLock(f.repo),other=join(f.dir,'keep');writeFileSync(other,'keep');const r=releaseAdoptLock(a);assert.ok(a.ok&&r.ok&&!existsSync(join(f.repo,'.trioharness-direct','issues.lock'))&&readFileSync(other,'utf8')==='keep');});
const script=fileURLToPath(new URL('./issues.mjs',import.meta.url));
function cliFixture(){const f=disk(),bin=join(f.repo,'bin'),ghdir=join(f.repo,'agent'),log=join(f.repo,'calls.jsonl'),marker=join(f.repo,'entered'),release=join(f.repo,'release');mkdirSync(bin);mkdirSync(ghdir);for(const r of ['other']){mkdirSync(join(f.repo,'.trioharness-direct','runs',r));writeFileSync(join(f.repo,'.trioharness-direct','runs',r,'state.json'),'{}');}
  const git=`#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='remote')console.log(a.length===1?'origin':'https://github.com/org/project.git');else if(a[0]==='ls-remote')console.log('ref: refs/heads/release\\tHEAD\\n${sha}\\tHEAD');else if(a[0]==='rev-parse')console.log('${sha}');else if(a[0]==='show')console.log(${JSON.stringify(JSON.stringify(config))});else process.exitCode=1;\n`;
  const gh=`#!/usr/bin/env node\nconst fs=require('fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({a,env:process.env})+'\\n');if(a[1]==='graphql'){if(a.join(' ').includes('viewer{login}'))console.log(JSON.stringify({data:{viewer:{login:'${bot}'}}}));else console.log(JSON.stringify({data:{repository:{issue:{author:{login:'${owner}'},editor:null,lastEditedAt:null}}}}));}else if(a.includes('-X')){let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(JSON.stringify({user:{login:'${bot}'}})));}else{fs.writeFileSync(${JSON.stringify(marker)},'entered');const deadline=Date.now()+10000;while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);console.log(JSON.stringify({number:12,html_url:'https://github.com/org/project/issues/12',title:'Task',body:'safe',state:'open',labels:[],user:{login:'${owner}'}}));}\n`;
  writeFileSync(join(bin,'git'),git,{mode:0o755});writeFileSync(join(bin,'gh'),gh,{mode:0o755});return {...f,log,marker,release,ghdir,env:{...process.env,PATH:`${bin}:${process.env.PATH}`,GH_CONFIG_DIR:ghdir,GH_TOKEN:['sent','inel-a'].join(''),GITHUB_TOKEN:['sent','inel-b'].join(''),GH_HOST:'sentinel-host'}};
}
function child(f,run='run'){const p=spawn(process.execPath,[script,'adopt','--checkout',f.repo,'--ledger',f.repo,'--repo',slug,'--run',run,'--issue','12'],{env:f.env});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',code=>resolve({code,out,err}));});return {done};}
async function entered(f,p){for(let i=0;i<1000&&!existsSync(f.marker);i++){await new Promise(r=>setTimeout(r,10));}return existsSync(f.marker);}
d('lock',5,async()=>{const f=cliFixture(),a=child(f);const began=await entered(f,a);const b=await child(f,'other').done;writeFileSync(f.release,'release');const first=await a.done,c=await child(f,'other').done;assert.ok(began&&first.code===0&&b.code===2&&b.err.includes('ADOPT_LOCKED')&&c.code===2&&c.err.includes('ISSUE_ALREADY_ADOPTED'));});
d('lock',6,async()=>{const f=cliFixture(),a=child(f);const began=await entered(f,a),path=join(f.repo,'.trioharness-direct','issues.lock'),before=existsSync(path)?readFileSync(path,'utf8'):'';const b=await child(f,'other').done,unchanged=existsSync(path)&&readFileSync(path,'utf8')===before;writeFileSync(f.release,'release');const first=await a.done;assert.ok(began&&before&&b.err.includes('ADOPT_LOCKED')&&unchanged&&first.code===0&&!existsSync(path));});
d('envscrub',1,async()=>{const f=cliFixture(),before=clone(process.env),stats=statSync(f.ghdir);writeFileSync(f.release,'release');const result=await child(f).done;const calls=existsSync(f.log)?readFileSync(f.log,'utf8').trim().split('\n').map(JSON.parse):[];assert.ok(result.code===0&&calls.length>=4&&calls.every(c=>!('GH_TOKEN'in c.env)&&!('GITHUB_TOKEN'in c.env)&&!('GH_HOST'in c.env)&&c.env.GH_CONFIG_DIR===f.ghdir)&&calls[0].a.join(' ').includes('viewer{login}')&&readdirSync(f.ghdir).length===0&&statSync(f.ghdir).mtimeMs===stats.mtimeMs);assert.deepEqual({...process.env},before);});


// Review-r1 regressions. Install questions bind their fixed id and full release SHA.
const installCard = (releaseSha=sha) => ({id:'Q-1',status:'answered',answeredVia:'card',card:{questions:[{id:'install',releaseSha,options:[{id:'install'},{id:'decline'}]}]},answers:{install:'install'}});
function installFixture(card=installCard(), evidence={cardId:'Q-1',releaseSha:sha,readbackPassed:true}, over={}) {
  const repo='org/trioharness-lean',initial=ledger({d2:entry({status:'merged',mergeSha:sha,...over})});initial.repo=repo;
  const f=fixture({repo},initial);f.store.cards.push(card);
  const path=join(root(),'install.json');writeFileSync(path,JSON.stringify(evidence));return {...f,path};
}
d('fix',1,async()=>{
  const cards=[{id:'Q-1',status:'answered',answers:{merge:'approve'}}, {...installCard(),answers:{merge:'install'}}, installCard('b'.repeat(40)), {...installCard(),answeredVia:'standing-order'}, {...installCard(),status:'assumed'}, {...installCard(),answers:{install:'decline'}}];
  const results=[];
  for(const card of cards){const f=installFixture(card),r=await f.transition('installed',{installEvidence:f.path});results.push(r.code);assert.equal(writes(f.calls).length,0);}
  assert.deepEqual(results,Array(cards.length).fill('INSTALL_UNVERIFIED'));
  const f=installFixture();assert.equal((await f.transition('installed',{installEvidence:f.path})).ok,true);assert.equal(f.store.data.run.issues.d2.state,'closed');
});
d('fix',2,async()=>{
  const results=[];
  for(const [op,args] of [['set-status',{status:'in-progress'}],['comment',{body:'safe'}],['close',{notPlanned:true,reason:'limit'}]]){
    const f=fixture(),before=clone(f.store.data);const r=await f.ctx.execute(op,args);results.push(r.code);
    assert.equal(writes(f.calls).length,0);assert.deepEqual(f.store.data,before);assert.equal(r.exitCode,2);
  }
  assert.deepEqual(results,Array(3).fill('ISSUE_KEY_REQUIRED'));
});
d('fix',3,async()=>{
  const f=fixture({},ledger({d2:entry({status:'in-review'})})),g=fixture();
  const a=await f.transition('writer-start'),b=await g.transition('merged');
  assert.deepEqual([a.code,b.code],['STATUS_REGRESSION','MERGE_UNVERIFIED']);assert.deepEqual([a.exitCode,b.exitCode],[2,2]);
  assert.deepEqual([f.store.data.run.pending.length,g.store.data.run.pending.length],[0,0]);assert.equal(writes(f.calls).length+writes(g.calls).length,0);
});
d('fix',4,async()=>{
  const f=fixture();f.store.data.run.pending.push({op:'transition',args:{event:'merged',key:'d2'},error:'MERGE_UNVERIFIED'},{op:'comment',args:{key:'d2',body:'retry'},error:'GH_UNAVAILABLE'});
  f.setLive({labels:['status:in-review']});const r=await f.execute('sync');
  assert.equal(f.store.data.run.pending[0].resolved,undefined);assert.ok(f.store.data.run.pending[1].resolved);
  assert.ok(writes(f.calls).some(c=>c.args[1].endsWith('/comments')));assert.ok(writes(f.calls).some(c=>c.args.includes('PUT')));
  assert.equal(r.code,'ISSUES_PENDING');assert.deepEqual(r.pending,[{index:0,code:'MERGE_UNVERIFIED'}]);
});
d('fix',5,async()=>{
  const f=rollFixture();assert.equal((await f.transition('rollback',{target:'prod',toRevision:'missing'})).code,'ROLLBACK_UNRESOLVED');
  f.setLive({labels:['status:deployed-prod'],state:'closed'});
  const retry=await f.execute('sync');assert.equal(retry.code,'ISSUES_PENDING');assert.equal(f.store.data.run.pending.length,1);
  f.setLive({labels:['status:deployed-qa'],state:'open'});
  const r=await f.execute('sync',{rollbackPending:'0',toSha:'b'.repeat(40)});
  assert.equal(r.ok,true);assert.ok(f.store.data.run.pending[0].resolved);assert.equal(f.store.data.run.pending[0].resolved.toSha,'b'.repeat(40));
  assert.equal(f.store.data.run.issues.d2.status,'deployed-qa');assert.equal(f.store.data.run.issues.d2.state,'open');
});
d('fix',6,async()=>{
  const checkout=root(),git=a=>execFileSync('git',a,{cwd:checkout,encoding:'utf8',stdio:'pipe'});
  git(['init','-q']);writeFileSync(join(checkout,'file'),'one');git(['add','file']);git(['commit','-qm','one']);const mergeSha=git(['rev-parse','HEAD']).trim();
  const f=rollFixture({checkout,git,ancestor:undefined},{mergeSha}),before=clone(f.store.data.run.issues);
  const r=await f.transition('rollback',{target:'prod',toSha:'b'.repeat(40)});
  assert.equal(r.code,'ROLLBACK_UNRESOLVED');assert.deepEqual(f.store.data.run.issues,before);assert.equal(writes(f.calls).length,0);assert.equal(f.store.data.run.pending.length,1);
});
d('fix',7,async()=>{
  const f=fixture();f.setLive({labels:['security','status:in-progress']});assert.equal((await f.execute('close',{notPlanned:true,reason:'limit'})).ok,true);
  assert.deepEqual(f.store.data.run.issues.d2.labels,['security','wontfix']);assert.equal(f.store.data.run.issues.d2.status,'withdrawn');
  f.setLive({labels:['security','wontfix'],state:'closed'});assert.equal((await f.execute('sync')).ok,true);
  const g=fixture({},ledger({d2:entry({source:'adopted'})}));g.setLive({state:'closed',labels:['harness-defect','status:triaged']});
  assert.equal((await g.execute('sync')).ok,true);assert.deepEqual(g.store.data.run.issues.d2.labels,['harness-defect','wontfix']);
  assert.ok([...writes(f.calls),...writes(g.calls)].filter(c=>c.args.includes('PUT')).every(c=>!JSON.parse(c.input).labels.some(l=>l.startsWith('status:'))));
});
d('fix',9,async()=>{
  for(const text of ['Fixes: #12','Resolves https://github.com/org/project/issues/12','Closed: org/project#12']) {
    const f=fixture({gh:async a=>ok(a[1].split('?')[0].endsWith('/commits')?[{commit:{message:text}}]:{body:'Refs #12',head:{sha}})});
    assert.equal((await f.transition('pr-open',{pr:2})).code,'AUTOCLOSE_KEYWORD');assert.equal(writes(f.calls).length,0);
  }
});
d('fix',10,async()=>{
  for(const event of ['writer-start','merged']){const f=fixture({},ledger({d2:entry({status:'withdrawn'})}));const before=clone(f.store.data.run.issues);
    assert.equal((await f.transition(event)).code,'STATUS_WITHDRAWN');assert.deepEqual(f.store.data.run.issues,before);assert.equal(writes(f.calls).length,0);assert.equal(f.store.data.run.pending.length,0);}
  const f=fixture({},ledger({d2:entry({status:'withdrawn'})}));assert.equal((await f.execute('set-status',{status:'in-review'})).code,'STATUS_WITHDRAWN');
});
d('fix',11,async()=>{
  const f=cliFixture();f.store.write('run',ledger({d2:entry()}));writeFileSync(f.release,'release');
  const p=spawn(process.execPath,[script,'set-status','--checkout',f.repo,'--ledger',f.repo,'--repo',slug,'--run','run','--key','d2','--status','in-progress','--store','injected','--config','injected','--gh','injected','--ancestor','injected','--trusted-default','injected','--spawn','injected','--env','injected'],{env:f.env});
  let err='';p.stderr.on('data',x=>err+=x);p.stdout.resume();const code=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',resolve);});assert.equal(code,0,err);
  assert.equal(f.store.read('run').issues.d2.status,'in-progress');assert.ok(readFileSync(f.log,'utf8').includes('viewer{login}'));
});
d('fix',12,async()=>{
  const f=installFixture({id:'Q-1',status:'answered',answers:{merge:'approve'}},undefined,{status:'released',install:{cardId:'Q-1',releaseSha:sha,readbackPassed:true}});
  assert.equal((await f.execute('close',{completed:true})).code,'CLOSE_BEFORE_DELIVERY');assert.equal(writes(f.calls).length,0);
});
d('fix',13,async()=>{
  const f=rollFixture({ancestor:(a)=>{if(a===sha)return false;throw Object.assign(new Error('missing object'),{status:128});}});
  f.store.data.run.issues.d3=entry({key:'d3',number:13,status:'deployed-prod',state:'closed',mergeSha:'c'.repeat(40),deliveries:[delivered('prod')]});const before=clone(f.store.data.run.issues);
  assert.equal((await f.ctx.transition('rollback',{target:'prod',toSha:'b'.repeat(40)})).code,'ROLLBACK_UNRESOLVED');assert.deepEqual(f.store.data.run.issues,before);assert.equal(writes(f.calls).length,0);
});


// Review-r2 regressions: durable hook failures, bounded replay and narrow supersession.
function reviewGh() {
  const live={state:'open',labels:['status:triaged']},calls=[];let down=false;
  const gh=async(args,input)=>{
    calls.push({args,input});if(down)return {ok:false,out:'',err:'offline'};
    const path=args[1]?.split('?')[0],method=args.includes('-X')?args[args.indexOf('-X')+1]:null;
    if(path==='graphql')return ok({data:{viewer:{login:bot}}});
    if(path?.endsWith('/commits'))return ok([]);
    if(path?.includes('/pulls/'))return ok({number:2,body:'Refs #12',head:{sha},merged:false});
    if(path?.endsWith('/comments'))return ok({user:{login:bot}});
    if(method==='PUT')live.labels=JSON.parse(input).labels;
    if(method==='PATCH')Object.assign(live,JSON.parse(input));
    return ok(live);
  };
  return {gh,calls,live,setDown:value=>{down=value;}};
}
d('fix',14,async()=>{
  const f=disk(),id=identity(),gh=reviewGh();f.store.write('run',ledger({d2:entry({status:'merged',mergeSha:sha})}));
  const opts={...id.opts,ledger:f.repo,store:f.store,run:'run',spawn:gh.gh,ancestor:()=>true,target:'qa',sha,revision:'r1',key:'d2'};
  gh.setDown(true);const r=await transitionForEvent('deployed-qa',opts);
  assert.equal(r.ok,false);assert.match(String(issueLedgerReason(f.repo,'run')),/ISSUES_PENDING|ISSUES_HOOK_FAILED/);
  const path=join(f.dir,'issues-failures.jsonl');assert.equal(existsSync(path),true);
  const failure=JSON.parse(readFileSync(path,'utf8').trim());assert.equal(failure.category,'IDENTITY_UNVERIFIED');
  assert.deepEqual(Object.keys(failure).sort(),['v','kind','ts','run','event','category','key'].sort());assert.equal(f.store.read('run').issues.d2.deliveries.length,0);
  gh.setDown(false);assert.equal((await transitionForEvent('deployed-qa',opts)).ok,true);
  const replay=createIssues({...opts,gh:gh.gh,config});assert.equal((await replay.execute('sync')).ok,true);
  assert.equal(issueLedgerReason(f.repo,'run'),null);assert.equal(f.store.read('run').issues.d2.status,'deployed-qa');
  const records=readFileSync(path,'utf8').trim().split('\n').map(JSON.parse);assert.equal(records.at(-1).kind,'resolved');
});
d('fix',15,async()=>{
  const codes=['IDENTITY_UNVERIFIED','IDENTITY_CONFIG_UNTRUSTED','IDENTITY_NOT_CONFIGURED','IDENTITY_CONFIG_INVALID','IDENTITY_CONFIG_REPO_MISMATCH','IDENTITY_IS_DEFAULT_GH_DIR','IDENTITY_IS_OWNER','IDENTITY_MISMATCH','DEFAULT_UNVERIFIED','REMOTE_UNVERIFIED'];
  for(const code of codes){
    const f=disk();f.store.write('run',ledger({d2:entry({status:'in-review',prs:[{number:2,sha}]})}));
    const r=await transitionForEvent('merged',{repo:slug,ledger:f.repo,run:'run',store:f.store,gh:async()=>ok({}),config,trustedDefault:()=>{throw Object.assign(new Error(secret()),{code});},key:'d2'});
    assert.equal(r.ok,false);const path=join(f.dir,'issues-failures.jsonl');assert.equal(existsSync(path),true,code);
    const raw=readFileSync(path,'utf8');assert.equal(raw.includes(secret()),false);assert.equal(JSON.parse(raw).category,'IDENTITY_UNVERIFIED');assert.match(String(issueLedgerReason(f.repo,'run')),/ISSUES_PENDING|ISSUES_HOOK_FAILED/);
  }
  // A real trusted-default failure also blocks; delivery hooks track other runs of this repo.
  const f=disk(),id=identity();f.store.write('other',ledger({d2:entry({status:'merged',mergeSha:sha})}));
  const opts={...id.opts,ledger:f.repo,run:'run',store:f.store,git:()=>{throw new Error('offline');},target:'qa',sha};
  assert.equal((await transitionForEvent('deployed-qa',opts)).ok,false);assert.match(String(issueLedgerReason(f.repo,'run')),/ISSUES_PENDING|ISSUES_HOOK_FAILED/);
  const quiet=disk();await transitionForEvent('writer-start',{repo:slug,ledger:quiet.repo,run:'run',store:quiet.store,env:{}});
  assert.equal(issueLedgerReason(quiet.repo,'run'),null);assert.equal(existsSync(join(quiet.dir,'issues.json')),false);assert.equal(existsSync(join(quiet.dir,'issues-failures.jsonl')),false);
  const corrupt=disk();writeFileSync(join(corrupt.dir,'issues.json'),'{');
  await transitionForEvent('writer-start',{repo:slug,ledger:corrupt.repo,run:'run',env:{}});
  assert.equal(JSON.parse(readFileSync(join(corrupt.dir,'issues-failures.jsonl'),'utf8')).category,'IDENTITY_UNVERIFIED');
});
d('fix',16,async()=>{
  const f=disk();f.store.write('run',ledger({d2:entry({status:'in-review'})}));const gh=reviewGh();
  const opts={repo:slug,ledger:f.repo,run:'run',store:f.store,gh:gh.gh,config,key:'d2'};
  const interactive=createIssues(opts);assert.equal((await interactive.transition('writer-start',{key:'d2'})).code,'STATUS_REGRESSION');
  assert.equal(issueLedgerReason(f.repo,'run'),null);
  assert.equal((await transitionForEvent('writer-start',opts)).code,'STATUS_REGRESSION');assert.match(String(issueLedgerReason(f.repo,'run')),/ISSUES_PENDING|ISSUES_HOOK_FAILED/);
  assert.equal(f.store.read('run').pending.length,1);assert.equal(f.store.read('run').issues.d2.status,'in-review');
  gh.live.labels=['status:in-review'];assert.equal((await interactive.execute('sync')).ok,true);assert.equal(issueLedgerReason(f.repo,'run'),null);
  assert.equal(f.store.read('run').pending[0].resolved.reason,'superseded');
});
d('fix',17,async()=>{
  for(const op of ['sync','list']){
    const f=fixture({gh:async()=>({ok:false,out:'',err:'offline'})});
    assert.equal((await f.execute(op,{live:true})).ok,false);assert.equal(f.store.data.run.pending.length,0,op);
  }
});
d('fix',18,async()=>{
  for(const stuck of [false,true]){
    const data=ledger({d2:entry()});if(stuck)data.pending.push({op:'transition',args:{event:'merged',key:'d2'},error:'MERGE_UNVERIFIED'});
    const index=data.pending.length;data.pending.push({op:'sync',args:{},error:'GH_UNAVAILABLE'},{op:'comment',args:{key:'d2',body:'once'},error:'GH_UNAVAILABLE'});
    const store=memory({run:data}),read=store.read,gh=reviewGh();let reads=0;
    // A fixture budget makes the pre-fix recursion fail promptly, without exhausting the process.
    store.read=r=>{if(++reads>30)throw new Error('fixture read budget exceeded');return read(r);};
    const ctx=createIssues({repo:slug,checkout:root(),ledger:root(),run:'run',store,gh:gh.gh,config});const r=await ctx.execute('sync');
    assert.ok(reads<=15,`unexpected recursive replay: ${reads} reads`);assert.equal(r.ok,!stuck);
    assert.equal(store.data.run.pending[index].resolved.reason,'sync-refreshed');assert.ok(store.data.run.pending[index+1].resolved);
    assert.equal(gh.calls.filter(c=>c.args[1].endsWith('/comments')).length,1);assert.equal(store.data.run.pending.length,index+2);
  }
});
d('fix',19,async()=>{
  const store=memory({run:ledger({d2:entry()})}),gh=reviewGh();store.data.run.pending.push({op:'comment',args:{key:'d2',body:'first'},error:'GH_UNAVAILABLE'});
  let appended=false;const ctx=createIssues({repo:slug,checkout:root(),ledger:root(),run:'run',store,config,gh:async(a,i)=>{
    if(!appended&&a[1].endsWith('/comments')){appended=true;const l=store.read('run');l.pending.push({op:'comment',args:{key:'d2',body:'later'},error:'GH_UNAVAILABLE'});store.write('run',l);}
    return gh.gh(a,i);
  }});
  const first=await ctx.execute('sync');assert.equal(gh.calls.filter(c=>c.args[1].endsWith('/comments')).length,1);
  assert.ok(store.data.run.pending[0].resolved);assert.equal(store.data.run.pending[1].resolved,undefined);assert.equal(first.code,'ISSUES_PENDING');
  assert.equal((await ctx.execute('sync')).ok,true);assert.equal(gh.calls.filter(c=>c.args[1].endsWith('/comments')).length,2);assert.ok(store.data.run.pending[1].resolved);
});
d('fix',20,async()=>{
  for(const op of ['set-status','writer-start']){
    const f=disk(),gh=reviewGh();f.store.write('run',ledger({d2:entry()}));const g=fixture({store:f.store,ledger:f.repo,gh:gh.gh});
    gh.setDown(true);const failed=op==='set-status'?await g.execute(op,{status:'in-progress'}):await g.transition(op);assert.equal(failed.code,'ISSUE_UPDATE_PENDING');
    gh.setDown(false);assert.equal((await g.transition('pr-open',{pr:2})).ok,true);const before=clone(f.store.read('run').issues);const writesBefore=writes(gh.calls).length;
    assert.equal((await g.execute('sync')).ok,true);const after=f.store.read('run');assert.equal(after.pending.length,1);assert.equal(after.pending[0].resolved.reason,'superseded');
    assert.deepEqual(after.issues,before);assert.equal(writes(gh.calls).length,writesBefore);assert.equal(issueLedgerReason(f.repo,'run'),null);
  }
});
d('fix',21,async()=>{
  const f=fixture({},ledger({d2:entry({status:'in-review'})}));
  f.store.data.run.pending.push(
    {op:'set-status',args:{key:'d2',status:'in-progress'},error:'GH_UNAVAILABLE'},
    {op:'transition',args:{event:'writer-start',key:'d2'},error:'GH_UNAVAILABLE'},
    {op:'comment',args:{key:'d2',body:'still required'},error:'GH_UNAVAILABLE'},
    {op:'transition',args:{event:'rollback',key:'d2'},error:'ROLLBACK_UNRESOLVED'},
    {op:'transition',args:{event:'merged',key:'d2'},error:'MERGE_UNVERIFIED'},
    {op:'set-status',args:{key:'d2',status:'released'},error:'GH_UNAVAILABLE'},
    {op:'set-status',args:{key:'missing',status:'in-progress'},error:'GH_UNAVAILABLE'},
    {op:'set-status',args:{status:'in-progress'},error:'GH_UNAVAILABLE'});
  const beforeIssues=clone(f.store.data.run.issues);
  for(const pendingIndex of ['0','1']){assert.equal((await f.execute('resolve-superseded',{pendingIndex})).ok,true);assert.equal(f.store.data.run.pending[Number(pendingIndex)].resolved.reason,'superseded');}
  for(const pendingIndex of ['0','2','3','4','5','6','7','-1','01','999']){
    const before=clone(f.store.data);assert.equal((await f.execute('resolve-superseded',{pendingIndex})).code,'SUPERSEDED_PENDING_INVALID');assert.deepEqual(f.store.data,before);
  }
  const terminal=fixture({},ledger({d2:entry({status:'withdrawn'})}));terminal.store.data.run.pending.push({op:'set-status',args:{key:'d2',status:'in-progress'},error:'GH_UNAVAILABLE'});
  assert.equal((await terminal.execute('resolve-superseded',{pendingIndex:'0'})).code,'SUPERSEDED_PENDING_INVALID');
  assert.equal(f.calls.length,0);assert.deepEqual(f.store.data.run.issues,beforeIssues);assert.equal(f.store.data.run.pending[2].resolved,undefined);
});
d('fix',22,async()=>{
  const f=fixture({},ledger({d2:entry({status:'in-review'})}));f.setLive({labels:['harness-defect','status:in-review']});
  f.store.data.run.pending.push({op:'set-status',args:{key:'d2',status:'in-review'},error:'GH_UNAVAILABLE'});
  assert.equal((await f.execute('sync')).ok,true);assert.equal(f.store.data.run.pending[0].resolved.reason,'superseded');assert.equal(writes(f.calls).length,0);
  const store=memory({run:ledger({d2:entry({status:'in-review'}),d3:entry({key:'d3',number:13})})}),gh=reviewGh();
  store.data.run.pending.push({op:'transition',args:{event:'writer-start'},error:'GH_UNAVAILABLE'});
  const ctx=createIssues({repo:slug,checkout:root(),ledger:root(),run:'run',store,gh:gh.gh,config});
  assert.equal((await ctx.execute('sync')).ok,true);assert.ok(store.data.run.pending[0].resolved);assert.equal(store.data.run.issues.d2.status,'in-review');assert.equal(store.data.run.issues.d3.status,'in-progress');
  assert.equal(gh.calls.filter(c=>c.args.includes('-X')&&c.args[1].includes('issues/12')).length,1); // drift repair only, never a writer-start regression
});

d('fix',23,async()=>{
  const f=fixture({},ledger({d2:entry({status:'in-review'}),d3:entry({key:'d3',number:13})}));
  f.store.data.run.pending.push({op:'set-status',args:{key:'d3',keys:'d2',issues:'d2',status:'in-progress'},error:'GH_UNAVAILABLE'});
  const before=clone(f.store.data);
  assert.equal((await f.execute('resolve-superseded',{pendingIndex:'0'})).code,'SUPERSEDED_PENDING_INVALID');assert.deepEqual(f.store.data,before);assert.equal(f.calls.length,0);
  assert.equal((await f.execute('sync')).ok,true);assert.equal(f.store.data.run.issues.d3.status,'in-progress');assert.equal(f.store.data.run.issues.d2.status,'in-review');
  assert.ok(f.store.data.run.pending[0].resolved);assert.equal(f.store.data.run.pending[0].resolved.reason,undefined);
  const g=fixture({},ledger({d2:entry({status:'in-review'}),d3:entry({key:'d3',number:13})}));
  g.store.data.run.pending.push({op:'set-status',args:{key:'d2',keys:'d3',issues:'d3',status:'in-progress'},error:'GH_UNAVAILABLE'});
  assert.equal((await g.execute('resolve-superseded',{pendingIndex:'0'})).ok,true);assert.equal(g.store.data.run.pending[0].resolved.reason,'superseded');assert.equal(g.store.data.run.issues.d3.status,'triaged');
});


// Review-r3: a keyless merged event is scoped to registered PRs, with proof per issue.
function mergeHookFixture() {
  const f=disk(),tip='c'.repeat(40),secondSha='b'.repeat(40),calls=[];
  const pr=(number,merged,commit)=>({number,merged,merge_commit_sha:commit,head:{sha:commit},body:`Refs #${number+10}`});
  const prs=new Map([[1,pr(1,true,sha)],[2,pr(2,false,secondSha)]]);
  const initial=ledger({d1:entry({key:'d1',number:11,status:'in-review',labels:['harness-defect','status:in-review'],state:'open',prs:[{number:1,sha}]}),d2:entry({state:'open'}),d3:entry({key:'d3',number:13,status:'withdrawn',state:'closed',labels:['harness-defect','wontfix']})});
  f.store.write('run',initial);const live=new Map(Object.values(initial.issues).map(e=>[e.number,{state:e.state,labels:clone(e.labels)}]));
  let offlinePr=null,contained=true;
  const gh=async(args,input)=>{
    calls.push({args,input});const path=args[1]?.split('?')[0],method=args.includes('-X')?args[args.indexOf('-X')+1]:null;
    const pull=path?.match(/\/pulls\/(\d+)(\/commits)?$/);
    if(pull){if(Number(pull[1])===offlinePr)return {ok:false,out:'',err:'offline'};return ok(pull[2]?[]:prs.get(Number(pull[1])));}
    const issue=path?.match(/\/issues\/(\d+)(\/labels)?$/);assert.ok(issue,`unexpected fixture request: ${path}`);
    const value=live.get(Number(issue[1]));assert.ok(value);
    if(method==='PUT')value.labels=JSON.parse(input).labels;
    if(method==='PATCH')Object.assign(value,JSON.parse(input));
    return ok(clone(value));
  };
  const opts={repo:slug,checkout:f.repo,ledger:f.repo,run:'run',store:f.store,gh,config,trustedDefault:()=>({sha:tip}),ancestor:()=>contained};
  const ctx=createIssues(opts);
  return {...f,ctx,opts,calls,prs,live,tip,secondSha,setOfflinePr:n=>{offlinePr=n;},setContained:value=>{contained=value;},registerSecond:()=>ctx.transition('pr-open',{key:'d2',pr:2}),hook:selectors=>transitionForEvent('merged',{...opts,...selectors})};
}
d('fix',24,async()=>{
  const f=mergeHookFixture(),withdrawn=clone(f.store.read('run').issues.d3);
  const first=await f.hook();assert.equal(first.ok,true);assert.deepEqual(first.keys,['d1']);
  assert.equal(f.store.read('run').issues.d1.mergeSha,sha);assert.equal(f.store.read('run').issues.d2.mergeSha,null);assert.equal(f.store.read('run').issues.d2.status,'triaged');
  assert.equal((await f.ctx.transition('deployed-qa',{key:'d1',target:'qa',sha:f.tip,revision:'qa-1'})).ok,true);
  assert.equal((await f.registerSecond()).ok,true);f.prs.get(2).merged=true;
  assert.equal((await f.ctx.execute('sync')).ok,true);const after=f.store.read('run');
  assert.equal(after.issues.d1.status,'deployed-qa');assert.equal(after.issues.d1.deliveries.length,1);assert.equal(after.issues.d2.status,'merged');assert.equal(after.issues.d2.mergeSha,f.secondSha);assert.deepEqual(after.issues.d3,withdrawn);
  assert.equal(after.pending.filter(p=>!p.resolved).length,0);assert.equal(issueLedgerReason(f.repo,'run'),null);
});
d('fix',25,async()=>{
  // Negative control: a PR marked merged without verified default ancestry is not proof.
  const f=mergeHookFixture();f.setContained(false);const before=clone(f.store.read('run').issues);
  const r=await f.hook();assert.equal(r.code,'MERGE_UNVERIFIED');assert.equal(r.exitCode,2);assert.deepEqual(f.store.read('run').issues,before);assert.equal(writes(f.calls).length,0);
  assert.match(String(issueLedgerReason(f.repo,'run')),/ISSUES_PENDING|ISSUES_HOOK_FAILED/);
  const failure=readFileSync(join(f.dir,'issues-failures.jsonl'),'utf8');assert.equal(JSON.parse(failure).event,'merged');
  const retry=await f.ctx.execute('sync');assert.equal(retry.code,'ISSUES_PENDING');assert.equal(f.store.read('run').pending.length,1);assert.equal(f.store.read('run').pending[0].resolved,undefined);assert.deepEqual(f.store.read('run').issues,before);
  f.setContained(true);assert.equal((await f.ctx.execute('sync')).ok,true);assert.ok(f.store.read('run').pending[0].resolved);assert.equal(issueLedgerReason(f.repo,'run'),null);
  assert.equal(readFileSync(join(f.dir,'issues-failures.jsonl'),'utf8').startsWith(failure),true);
});
d('fix',26,async()=>{
  for(const error of ['MERGE_UNVERIFIED','STATUS_WITHDRAWN','STATUS_REGRESSION']){
    const f=mergeHookFixture();assert.equal((await f.ctx.transition('merged',{key:'d1'})).ok,true);
    assert.equal((await f.ctx.transition('deployed-qa',{key:'d1',target:'qa',sha:f.tip,revision:'qa-1'})).ok,true);assert.equal((await f.registerSecond()).ok,true);
    const l=f.store.read('run');l.pending.push({op:'transition',args:{event:'merged'},error,at:'2026-10-31T00:00:00.000Z'});f.store.write('run',l);
    appendFailure({ledger:f.repo,run:'run',event:'merged',category:'OTHER'});
    appendFailure({ledger:f.repo,run:'run',event:'merged',category:'OTHER',key:'d2'});
    const advanced=clone(f.store.read('run').issues.d1),withdrawn=clone(f.store.read('run').issues.d3);f.calls.length=0;
    assert.equal((await f.ctx.execute('sync')).ok,true);const after=f.store.read('run');assert.ok(after.pending[0].resolved,error);assert.equal(after.pending.length,1);
    assert.deepEqual(after.issues.d1,advanced);assert.deepEqual(after.issues.d3,withdrawn);assert.equal(after.issues.d2.status,'in-review');assert.equal(after.issues.d2.mergeSha,null);
    assert.equal(f.calls.some(c=>c.args[1].endsWith('/pulls/1')),false);assert.equal(writes(f.calls).some(c=>c.args[1].includes('/issues/11')),false);
    // Proving d1 must not clear a separate keyed refusal for still-unproven d2.
    assert.match(String(issueLedgerReason(f.repo,'run')),/ISSUES_HOOK_FAILED/);
    f.prs.get(2).merged=true;assert.equal((await f.ctx.execute('sync')).ok,true);assert.equal(f.store.read('run').issues.d2.status,'merged');assert.equal(issueLedgerReason(f.repo,'run'),null);
  }
});
d('fix',27,async()=>{
  for(const target of ['qa','prod']){
    const f=mergeHookFixture();f.setOfflinePr(1);assert.equal((await f.hook({key:'d1'})).code,'ISSUE_UPDATE_PENDING');
    assert.match(String(issueLedgerReason(f.repo,'run')),/ISSUES_PENDING|ISSUES_HOOK_FAILED/);f.setOfflinePr(null);
    assert.equal((await f.ctx.transition('merged',{key:'d1'})).ok,true);
    assert.equal((await f.ctx.transition(`deployed-${target}`,{key:'d1',target,sha:f.tip,revision:'delivered-1'})).ok,true);
    const before=clone(f.store.read('run').issues.d1);f.calls.length=0;
    assert.equal((await f.ctx.execute('sync')).ok,true);assert.ok(f.store.read('run').pending[0].resolved);assert.equal(f.store.read('run').pending.length,1);
    assert.deepEqual(f.store.read('run').issues.d1,before);assert.equal(f.calls.some(c=>c.args[1].endsWith('/pulls/1')),false);assert.equal(writes(f.calls).some(c=>c.args[1].includes('/issues/11')),false);assert.equal(issueLedgerReason(f.repo,'run'),null);
  }
});
d('fix',28,async()=>{
  const f=mergeHookFixture();assert.equal((await f.registerSecond()).ok,true);const r=await f.hook();assert.equal(r.ok,true);assert.deepEqual(r.keys,['d1']);
  assert.equal(f.store.read('run').issues.d2.status,'in-review');assert.equal(f.store.read('run').issues.d2.mergeSha,null);
  // Explicit selectors remain strict, including multi-issue selectors with only partial proof.
  for(const selectors of [{key:'d2'},{keys:'d1,d2'},{issues:'11,12'}]){
    const g=mergeHookFixture();assert.equal((await g.registerSecond()).ok,true);const refused=await g.hook(selectors);assert.equal(refused.code,'MERGE_UNVERIFIED');assert.equal(g.store.read('run').issues.d2.mergeSha,null);assert.notEqual(g.store.read('run').issues.d2.status,'merged');assert.match(String(issueLedgerReason(g.repo,'run')),/ISSUES_PENDING|ISSUES_HOOK_FAILED/);
  }
  // A recorded higher status without mergeSha cannot be skipped as an already-proven merge.
  const missing=mergeHookFixture(),l=missing.store.read('run');l.issues.d2.status='deployed-qa';l.issues.d2.labels=['status:deployed-qa'];l.pending.push({op:'transition',args:{event:'merged',key:'d2'},error:'GH_UNAVAILABLE'});missing.store.write('run',l);missing.live.get(12).labels=['status:deployed-qa'];
  assert.equal((await missing.ctx.execute('sync')).code,'ISSUES_PENDING');assert.equal(missing.store.read('run').pending[0].resolved,undefined);assert.equal(missing.store.read('run').issues.d2.mergeSha,null);assert.match(String(issueLedgerReason(missing.repo,'run')),/ISSUES_PENDING/);
  // Merge evidence must not erase a lost delivery's fixed-event failure record.
  appendFailure({ledger:f.repo,run:'run',event:'deployed-qa',category:'GH_UNAVAILABLE',key:'d1'});
  assert.equal((await f.ctx.execute('sync')).ok,true);assert.match(String(issueLedgerReason(f.repo,'run')),/ISSUES_HOOK_FAILED/);
  assert.equal((await f.ctx.transition('deployed-qa',{key:'d1',target:'qa',sha:f.tip,revision:'qa-proof'})).ok,true);assert.equal(issueLedgerReason(f.repo,'run'),null);
});

// Review-r4: no eligible PRs is a no-op; later slices retain recorded merge proof.
for(const [n,issues] of [
  [29,{d3:entry({key:'d3',number:13,status:'withdrawn',state:'closed',prs:[{number:3,sha}]})}],
  [30,{d1:entry({key:'d1',number:11}),d2:entry({status:'in-progress'}),d3:entry({key:'d3',number:13,status:'withdrawn',state:'closed'})}],
  [31,{}]
])d('fix',n,async()=>{
  const f=disk(),initial=ledger(issues);f.store.write('run',initial);
  const before=readFileSync(join(f.dir,'issues.json'),'utf8');
  const r=await transitionForEvent('merged',{repo:slug,ledger:f.repo,run:'run',store:f.store,gh:async()=>assert.fail('no issue or PR request expected'),config,trustedDefault:()=>({sha})});
  assert.deepEqual(r,{ok:true,keys:[]});assert.deepEqual(f.store.read('run'),initial);
  assert.equal(readFileSync(join(f.dir,'issues.json'),'utf8'),before);
  assert.equal(existsSync(join(f.dir,'issues-failures.jsonl')),false);assert.equal(issueLedgerReason(f.repo,'run'),null);
});
d('fix',32,async()=>{
  for(const contained of [false,null]){
    const f=mergeHookFixture();f.setContained(contained);const before=clone(f.store.read('run').issues);
    const r=await f.hook();assert.equal(r.code,'MERGE_UNVERIFIED');assert.equal(r.exitCode,2);
    assert.deepEqual(f.store.read('run').issues,before);assert.equal(writes(f.calls).length,0);
    assert.equal(f.store.read('run').pending.length,1);assert.equal(f.store.read('run').pending[0].error,'MERGE_UNVERIFIED');
    assert.equal(JSON.parse(readFileSync(join(f.dir,'issues-failures.jsonl'),'utf8')).event,'merged');
    assert.match(String(issueLedgerReason(f.repo,'run')),/ISSUES_PENDING|ISSUES_HOOK_FAILED/);
  }
});
d('fix',33,async()=>{
  const f=mergeHookFixture();assert.equal((await f.hook()).ok,true);
  assert.equal((await f.ctx.transition('deployed-qa',{key:'d1',target:'qa',sha:f.tip,revision:'qa-1'})).ok,true);
  const advanced=clone(f.store.read('run').issues.d1),withdrawn=clone(f.store.read('run').issues.d3);
  assert.equal((await f.registerSecond()).ok,true);f.prs.get(2).merged=true;f.setOfflinePr(1);f.calls.length=0;
  const second=await f.hook();assert.deepEqual(second,{ok:true,keys:['d1','d2']});const after=f.store.read('run');
  assert.deepEqual(after.issues.d1,advanced);assert.deepEqual(after.issues.d3,withdrawn);
  assert.equal(after.issues.d2.status,'merged');assert.equal(after.issues.d2.mergeSha,f.secondSha);
  assert.equal(f.calls.some(c=>c.args[1].endsWith('/pulls/1')),false);
  assert.equal(writes(f.calls).some(c=>c.args[1].includes('/issues/11')),false);
  assert.equal(after.pending.length,0);assert.equal(existsSync(join(f.dir,'issues-failures.jsonl')),false);assert.equal(issueLedgerReason(f.repo,'run'),null);
});
d('fix',34,async()=>{
  for(const selectors of [{key:'d1'},{keys:'d1'},{issues:'11'}]){
    const f=mergeHookFixture();assert.equal((await f.hook()).ok,true);
    assert.equal((await f.ctx.transition('deployed-qa',{key:'d1',target:'qa',sha:f.tip,revision:'qa-1'})).ok,true);
    const before=clone(f.store.read('run').issues);f.calls.length=0;
    assert.equal((await f.hook(selectors)).code,'STATUS_REGRESSION');assert.deepEqual(f.store.read('run').issues,before);
    assert.equal(f.calls.some(c=>c.args[1].endsWith('/pulls/1')),true);assert.equal(f.store.read('run').pending.length,1);
  }
});
