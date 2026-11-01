import 'dotenv/config';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type Obj = Record<string, any>;
type Part = { id: string; jira: Obj; erd: Obj; frd: Obj };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(HERE, '../..');
const OUT = path.join(BASE, 'system_design_output');
const CHECK = path.join(OUT, 'checkpoints');
const PROMPT = path.join(HERE, 'system_design_prompt.txt');
const JIRA = path.join(BASE, 'src', 'BRD_TO_STORY', 'epics_and_stories.json');
const ERD = path.join(BASE, 'jira_erd_output', 'erd.json');
const FRD = path.join(BASE, 'frd_output', 'FRD.json');
const URL = process.env.LLM_URL || 'http://127.0.0.1:11434/api/chat';
const MODEL = process.env.LLM_MODEL || process.env.MODEL || 'llama3.2:3b';
const REQUIRED = ['systemOverview','actors','architecture','functionalModules','apis','businessFlows','dataFlows','databaseDesign','security','errorHandling','nonFunctionalArchitecture','deploymentArchitecture','traceability','architecturalDecisions','implementationSequence'];
const GROUPS = [
  ['systemOverview','actors','architecture'],
  ['functionalModules','apis'],
  ['businessFlows','dataFlows'],
  ['databaseDesign','security'],
  ['errorHandling','nonFunctionalArchitecture'],
  ['deploymentArchitecture','traceability'],
  ['architecturalDecisions','implementationSequence']
];
const obj = (x: unknown): x is Obj => x !== null && typeof x === 'object' && !Array.isArray(x);
const array = (x: unknown): any[] => Array.isArray(x) ? x : [];
const val = (x: unknown) => x == null ? '' : String(x).trim();
const pick = (...xs: any[]) => xs.find(x => x !== undefined && x !== null && x !== '') ?? '';
const json = (x: unknown) => JSON.stringify(x, null, 2);
const digest = (x: string) => createHash('sha256').update(x).digest('hex').slice(0, 20);
const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const epicsOf = (j: any) => array(Array.isArray(j) ? j : pick(j?.epics,j?.data,j?.items)).filter(obj);
const storiesOf = (e: Obj) => array(pick(e.stories,e.issues,e.children)).filter(obj);
const erdOf = (e: any) => obj(e?.erd) ? e.erd : e;
const entitiesOf = (e: Obj) => array(pick(e.entities,e.tables,e.models));
const relationsOf = (e: Obj) => array(pick(e.relationships,e.relations,e.associations));
const nameOf = (e: any) => typeof e === 'string' ? e : val(pick(e?.name,e?.entity,e?.table,e?.title));
const ident = (x: any) => val(pick(x?.key,x?.id,x?.sectionId,x?.name,x?.summary));

function partition(jira: any, erdRaw: any, frd: any): Part[] {
  const erd = erdOf(erdRaw);
  const items: {kind: 'epic'|'entity'|'relation'|'requirement'|'meta'; value: any; name: string}[] = [];
  for (const epic of epicsOf(jira)) {
    const stories = storiesOf(epic);
    const { stories: _a, issues: _b, children: _c, ...head } = epic;
    if (stories.length) for (const s of stories) items.push({kind:'epic',value:{...head,stories:[s]},name:ident(s)});
    else items.push({kind:'epic',value:epic,name:ident(epic)});
  }
  for (const e of entitiesOf(erd)) items.push({kind:'entity',value:e,name:nameOf(e)});
  for (const r of relationsOf(erd)) items.push({kind:'relation',value:r,name:'relation'});
  for (const r of array(frd?.functionalRequirements)) items.push({kind:'requirement',value:r,name:ident(r)});
  if (obj(frd)) {
    const { functionalRequirements: _reqs, ...metadata } = frd;
    if (Object.keys(metadata).length) items.push({kind:'meta',value:metadata,name:'FRD metadata'});
  }
  const limit = Math.max(2000, Number(process.env.SYSTEM_DESIGN_CHUNK_CHARS || 6500));
  const batches: typeof items[] = [];
  let current: typeof items = []; let size = 0;
  for (const item of items) {
    const n = json(item.value).length + 80;
    if (current.length && size+n>limit) { batches.push(current); current=[]; size=0; }
    current.push(item); size+=n;
  }
  if (current.length) batches.push(current);
  const epicIndex = epicsOf(jira).map(e=>({key:ident(e),name:val(pick(e.summary,e.name,e.title)),stories:storiesOf(e).map(ident)}));
  const entityIndex = entitiesOf(erd).map(nameOf);
  return batches.map((batch,i)=>({
    id:`${String(i+1).padStart(3,'0')}-${batch.map(x=>x.name).filter(Boolean).slice(0,2).join('-').replace(/[^a-z0-9-]/gi,'_').slice(0,50)}`,
    jira:{epics:batch.filter(x=>x.kind==='epic').map(x=>x.value),epicIndex},
    erd:{entities:batch.filter(x=>x.kind==='entity').map(x=>x.value),relationships:batch.filter(x=>x.kind==='relation').map(x=>x.value),entityIndex},
    frd:{functionalRequirements:batch.filter(x=>x.kind==='requirement').map(x=>x.value),metadata:batch.filter(x=>x.kind==='meta').map(x=>x.value)}
  }));
}

function external(template: string, j: any, e: any, f: any) {
  for (const token of ['__JIRA_TEXT__','__ERD_TEXT__','__FRD_TEXT__']) if (!template.includes(token)) throw new Error(`External prompt missing ${token}`);
  return template.split('__JIRA_TEXT__').join(json(j)).split('__ERD_TEXT__').join(json(e)).split('__FRD_TEXT__').join(json(f));
}

function parse(raw: string): Obj {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  let parsed: any;
  try { parsed=JSON.parse(clean); } catch {
    const a=clean.indexOf('{'), b=clean.lastIndexOf('}');
    if (a<0 || b<a) throw new Error('Response is not a complete JSON object');
    parsed=JSON.parse(clean.slice(a,b+1));
  }
  if (!obj(parsed)) throw new Error('Response must be a JSON object');
  return parsed;
}
function meaningful(x: any): boolean {
  if (typeof x==='string') return !!x.trim();
  if (Array.isArray(x)) return x.some(meaningful);
  if (obj(x)) return Object.values(x).some(meaningful);
  return typeof x==='number' || typeof x==='boolean';
}
async function call(prompt: string, rawPath: string): Promise<Obj> {
  const ollama = /\/api\/chat\/?(?:\?|$)/.test(URL);
  const ctrl = new AbortController();
  const timeout = setTimeout(()=>ctrl.abort(),Number(process.env.LLM_TIMEOUT_MS || 900000));
  try {
    const messages=[{role:'system',content:'Follow the complete external architecture specification. Return one concise valid JSON object. Never copy empty examples. Do not invent source facts.'},{role:'user',content:prompt}];
    const payload = ollama ? {model:MODEL,messages,format:'json',stream:false,options:{temperature:0.1,num_ctx:Number(process.env.OLLAMA_NUM_CTX||16384),num_predict:Number(process.env.OLLAMA_NUM_PREDICT||3072)}} : {model:MODEL,messages,temperature:0.1};
    const response=await fetch(URL,{method:'POST',signal:ctrl.signal,headers:{'Content-Type':'application/json',...(!ollama && process.env.LLM_API_KEY?{Authorization:`Bearer ${process.env.LLM_API_KEY}`}:{})},body:JSON.stringify(payload)});
    const body=await response.text();
    if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${body.slice(0,400)}`);
    const result=JSON.parse(body);
    const raw=ollama?result?.message?.content:result?.choices?.[0]?.message?.content;
    if (typeof raw!=='string' || !raw.trim()) throw new Error('Empty LLM response');
    await writeFile(rawPath,raw,'utf8');
    return parse(raw);
  } finally {clearTimeout(timeout);}
}
async function cached(id: string, prompt: string, validator: (x: Obj)=>void): Promise<Obj> {
  const key=digest(MODEL+'\n'+URL+'\n'+prompt+'\n'+process.env.OLLAMA_NUM_CTX+'\n'+process.env.OLLAMA_NUM_PREDICT);
  const target=path.join(CHECK,`${id}-${key}.json`);
  if (existsSync(target)) {
    try { const v=await readJson(target); validator(v); console.log('  Reusing checkpoint:',id); return v; }
    catch { console.log('  Invalid checkpoint; regenerating:',id); }
  }
  for(let attempt=1;attempt<=2;attempt++) {
    try {
      const v=await call(prompt,path.join(CHECK,`${id}-${key}-attempt${attempt}.txt`));
      validator(v);
      await writeFile(target,json(v),'utf8');
      return v;
    } catch(e) {
      console.error(`  ${id} attempt ${attempt} failed:`,e instanceof Error?e.message:e);
      if (attempt===2) throw new Error(`Stopped at ${id}. Completed checkpoints are preserved.`);
    }
  }
  throw new Error('Unexpected retry failure');
}

// Deterministic evidence accumulation: every source chunk contributes one small fact record.
function checkFacts(v: Obj) {
  if (!Array.isArray(v.modules) || !Array.isArray(v.entities) || !Array.isArray(v.requirements)) throw new Error('Fact JSON must contain modules, entities and requirements arrays');
}
function factPrompt(template: string, part: Part): string {
  return external(template,part.jira,part.erd,part.frd)+`\n\nEXECUTION MODE: SOURCE FACT EXTRACTION ONLY. The COMPLETE external specification above remains authoritative. Do NOT generate the 15-section system design yet. Extract only factual information from the CURRENT source chunk. Return a SHORT JSON object exactly shaped as {"modules":[{"name":"...","epicKeys":[],"storyKeys":[],"responsibilities":[],"apis":[]}],"entities":[{"name":"...","attributes":[],"relationships":[]}],"requirements":[{"id":"...","summary":"...","module":"...","storyKeys":[]}],"integrations":[],"securityFacts":[],"flows":[]}. Use empty arrays for categories absent in this chunk. Limit each description to one concise sentence. Do not hallucinate. Preserve source identifiers. Return JSON only.`;
}
function dedup(values: any[]): any[] {
  const seen=new Set<string>();
  return values.filter(x=>{const key=obj(x)?val(pick(x.id,x.name,x.key,x.endpoint,x.summary)).toLowerCase()||json(x):json(x);if(seen.has(key))return false;seen.add(key);return true;});
}
function merge(a:any,b:any):any {
  if (a===undefined || a===null || a==='') return b;
  if (b===undefined || b===null || b==='') return a;
  if (Array.isArray(a)&&Array.isArray(b)) return dedup([...a,...b]);
  if (obj(a)&&obj(b)) {const out={...a};for(const [k,v] of Object.entries(b))out[k]=merge(out[k],v);return out;}
  if (typeof a==='string'&&typeof b==='string') return a.length>=b.length?a:b;
  return a;
}
function checkSection(v:Obj,keys:string[]) {
  for(const k of keys) if (!(k in v)||!meaningful(v[k])) throw new Error(`Missing/empty section ${k}`);
  if(keys.includes('systemOverview')&&!val(v.systemOverview?.systemName))throw new Error('Empty systemName');
  if(keys.includes('architecture')&&!array(v.architecture?.components).some(x=>val(x?.name)))throw new Error('No named architecture components');
  if(keys.includes('functionalModules')&&!array(v.functionalModules).some(x=>val(x?.name)))throw new Error('No named modules');
  if(keys.includes('databaseDesign')&&!array(v.databaseDesign?.entities).some(x=>val(x?.name)))throw new Error('No named database entities');
}
function synthesisPrompt(template:string,facts:Obj,keys:string[],allNames:string[],part:number,total:number):string {
  const prompt=external(template,{epics:[],note:'All Jira evidence extracted into consolidated source facts below'},{entities:[],note:'All ERD evidence extracted into consolidated source facts below'},{functionalRequirements:[],note:'All FRD evidence extracted into consolidated source facts below'});
  return prompt+`\n\nCONSOLIDATED SOURCE FACTS (extracted from ALL Jira, ERD and FRD source chunks):\n${json(facts)}\n\nEXECUTION MODE: SYSTEM DESIGN SYNTHESIS ${part}/${total}. The COMPLETE external prompt above is authoritative, including its schema, quality rules and architecture instructions. Return ONLY these top-level sections: ${keys.join(', ')}. Use the schema specified in the external prompt. Generate detailed, specific, grounded components, dependencies, APIs and traceability. Avoid generic three-layer-only architecture. Do not return blank templates. Source entity names: ${allNames.join(', ')}. Return valid JSON only.`;
}
const label=(x:any)=>val(x).replace(/\s+/g,' ').replace(/"/g,"'").replace(/[<>]/g,'').slice(0,90);
function diagrams(d:Obj,erdRaw:any):Record<string,string> {
  const components=array(d.architecture?.components).filter(x=>val(x?.name));
  const modules=array(d.functionalModules).filter(x=>val(x?.name));
  const actors=array(d.actors).filter(x=>val(x?.name));
  const erd=erdOf(erdRaw);
  const entities=entitiesOf(erd).map(nameOf).filter(Boolean);
  const init="%%{init: {'theme': 'base', 'flowchart': {'htmlLabels': false, 'nodeSpacing': 70, 'rankSpacing': 80}}}%%\nflowchart TB\n";
  const base=[init,'subgraph CLIENT["Actors and Clients"]',...actors.map((a,i)=>`A${i}["${label(a.name)}"]`),'end','subgraph APP["Application Components"]',...components.map((c,i)=>`C${i}["${label(c.name)}"]`),'end','subgraph MODULES["Functional Modules"]',...modules.map((m,i)=>`M${i}["${label(m.name)}"]`),'end','subgraph DATA["ERD Entities"]',...entities.map((e,i)=>`D${i}[("${label(e)}")]`),'end'];
  const compMap=new Map(components.map((c,i)=>[val(c.name).toLowerCase(),`C${i}`]));
  const entityMap=new Map(entities.map((e,i)=>[e.toLowerCase(),`D${i}`]));
  const edges=new Set<string>();
  if(components.length)actors.forEach((_,i)=>edges.add(`A${i} --> C0`));
  components.forEach((c,i)=>{for(const x of array(c.dependencies)){const dest=compMap.get(val(obj(x)?pick(x.name,x.component):x).toLowerCase());if(dest&&dest!==`C${i}`)edges.add(`C${i} --> ${dest}`);}for(const x of array(c.ownedData)){const dest=entityMap.get(val(x).toLowerCase());if(dest)edges.add(`C${i} --> ${dest}`);}});
  modules.forEach((m,i)=>{for(const x of array(m.erdEntities)){const dest=entityMap.get(val(x).toLowerCase());if(dest)edges.add(`M${i} --> ${dest}`);}const c=components.findIndex(x=>val(x.name).toLowerCase().includes(val(m.name).toLowerCase()));if(c>=0)edges.add(`C${c} --> M${i}`);});
  const overall=[...base,...edges,'classDef actor fill:#dceafd,stroke:#3863a0','classDef component fill:#d9f5e9,stroke:#2c8464','classDef module fill:#eee3fc,stroke:#8359ad','classDef data fill:#fff0d4,stroke:#a97829',...actors.map((_,i)=>`class A${i} actor`),...components.map((_,i)=>`class C${i} component`),...modules.map((_,i)=>`class M${i} module`),...entities.map((_,i)=>`class D${i} data`)].join('\n')+'\n';
  const data=[init,'subgraph DATABASE["Data Model - Source ERD"]',...entities.map((e,i)=>`E${i}[("${label(e)}")]`),'end'];
  const sourceRelations=relationsOf(erd);
  for(const r of sourceRelations){const a=entities.findIndex(e=>e.toLowerCase()===val(pick(r?.from,r?.source,r?.entity1)).toLowerCase());const b=entities.findIndex(e=>e.toLowerCase()===val(pick(r?.to,r?.target,r?.entity2)).toLowerCase());if(a>=0&&b>=0&&a!==b)data.push(`E${a} --> E${b}`);}
  const moduleViews:Record<string,string>={};
  modules.forEach((m,i)=>{
    const used=array(m.erdEntities).map(val).filter(Boolean);
    const lines=[init,`M0["${label(m.name)}"]`,...used.map((x,j)=>`D${j}[("${label(x)}")]`),...used.map((_,j)=>`M0 --> D${j}`)];
    moduleViews[`module_${String(i+1).padStart(2,'0')}`]=lines.join('\n')+'\n';
  });
  return {system_design:overall,data_architecture:data.join('\n')+'\n',...moduleViews};
}
async function render(input:string,output:string) {
  const cli=path.join(BASE,'node_modules','@mermaid-js','mermaid-cli','src','cli.js');
  if(!existsSync(cli))throw new Error('Install Mermaid CLI: npm.cmd install --save-dev @mermaid-js/mermaid-cli');
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,'-i',input,'-o',output,'-b','white','-s','3'],{cwd:BASE,stdio:'inherit',shell:false});
    child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`Mermaid renderer exited ${code}`)));
  });
}
async function main() {
  for(const p of [JIRA,ERD,FRD,PROMPT])if(!existsSync(p))throw new Error(`Missing local input: ${p}. No Jira downloads or generators are run.`);
  const [jira,erd,frd,template]=await Promise.all([readJson(JIRA),readJson(ERD),readJson(FRD),readFile(PROMPT,'utf8')]);
  if(!template.trim())throw new Error('External prompt is empty');
  if(!epicsOf(jira).length||!entitiesOf(erdOf(erd)).length||!obj(frd))throw new Error('Jira, ERD or FRD input invalid');
  await mkdir(CHECK,{recursive:true});
  console.log(`Complete external prompt: ${PROMPT} (${template.length} characters)`);
  const parts=partition(jira,erd,frd);
  console.log(`Stage 1: ${parts.length} source extraction chunks, with checkpoints`);
  const facts:Obj={modules:[],entities:[],requirements:[],integrations:[],securityFacts:[],flows:[]};
  for(let i=0;i<parts.length;i++) {
    const p=parts[i];console.log(`Extract ${i+1}/${parts.length}: ${p.id}`);
    const f=await cached(`facts_${String(i+1).padStart(3,'0')}`,factPrompt(template,p),checkFacts);
    for(const [k,v] of Object.entries(f))facts[k]=merge(facts[k],v);
  }
  const factPath=path.join(OUT,'architecture_facts.json');
  await writeFile(factPath,json(facts),'utf8');
  const maxChars=Number(process.env.SYSTEM_DESIGN_FACTS_MAX_CHARS||42000);
  if(json(facts).length>maxChars)throw new Error(`Consolidated facts (${json(facts).length} chars) exceed budget ${maxChars}. Reduce SYSTEM_DESIGN_CHUNK_CHARS or increase model context; facts saved to ${factPath}. No facts were silently truncated.`);
  console.log(`Stage 2: ${GROUPS.length} section synthesis calls, with checkpoints`);
  const design:Obj={};const names=entitiesOf(erdOf(erd)).map(nameOf);
  for(let i=0;i<GROUPS.length;i++) {
    const keys=GROUPS[i];console.log(`Synthesize ${i+1}/${GROUPS.length}: ${keys.join(', ')}`);
    const result=await cached(`section_${i+1}`,synthesisPrompt(template,facts,keys,names,i+1,GROUPS.length),v=>checkSection(v,keys));
    for(const k of keys)design[k]=result[k];
  }
  for(const k of REQUIRED)if(!meaningful(design[k]))throw new Error(`Final design section empty: ${k}`);
  const pending=path.join(OUT,'system_design.pending.json');
  await writeFile(pending,json(design),'utf8');
  const diagramsDir=path.join(OUT,'diagrams');await mkdir(diagramsDir,{recursive:true});
  const all=diagrams(design,erd);
  for(const [name,mmd] of Object.entries(all)) {
    const mmdPath=path.join(diagramsDir,`${name}.mmd`);
    await writeFile(mmdPath,mmd,'utf8');
    await render(mmdPath,path.join(diagramsDir,`${name}.png`));
    await render(mmdPath,path.join(diagramsDir,`${name}.svg`));
  }
  await rename(pending,path.join(OUT,'system_design.json'));
  await writeFile(path.join(OUT,'system_design.mmd'),all.system_design,'utf8');
  // Compatibility: keep the historical top-level PNG output.
  await render(path.join(OUT,'system_design.mmd'),path.join(OUT,'system_design.png'));
  console.log(`Completed. ${Object.keys(all).length} diagram views; output: ${OUT}`);
}
main().catch(e=>{console.error('System Design failed:',e);process.exitCode=1;});