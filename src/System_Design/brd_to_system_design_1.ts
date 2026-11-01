import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

type Obj = Record<string, any>;
const BASE = process.cwd(); // Run from BRD_TS project root
const HERE = path.join(BASE, 'src', 'System_Design');
const PROMPT_PATH = path.join(HERE, 'system_design_prompt.txt');
const JIRA = path.join(BASE, 'src', 'epics_and_stories.json');
const ERD = path.join(BASE, 'jira_erd_output', 'erd.json');
const FRD = path.join(BASE, 'frd_output', 'FRD.json');
const OUT = path.join(BASE, 'system_design_output');
const DESIGN = path.join(OUT, 'system_design.json');
const MERMAID = path.join(OUT, 'system_design.mmd');
const PNG = path.join(OUT, 'system_design.png');
const URL = process.env.LLM_URL || 'http://127.0.0.1:11434/api/chat';
const MODEL = process.env.LLM_MODEL || process.env.MODEL || 'llama3.2:3b';
const API_KEY = process.env.LLM_API_KEY;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): any[] => Array.isArray(v) ? v : [];
const s = (v: unknown): string => typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
const pick = (...v: unknown[]): unknown => v.find(x => x !== undefined && x !== null && x !== '') ?? '';
const short = (v: unknown, n = 280) => s(v).replace(/\s+/g, ' ').slice(0, n);
const json = (v: unknown) => JSON.stringify(v, null, 2);
const readJson = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const REQUIRED = ['systemOverview','actors','architecture','functionalModules','apis','businessFlows','dataFlows','databaseDesign','security','errorHandling','nonFunctionalArchitecture','deploymentArchitecture','traceability','architecturalDecisions','implementationSequence'] as const;
const GROUPS: { title: string; keys: string[] }[] = [
  {title:'Overview and core architecture', keys:['systemOverview','actors','architecture']},
  {title:'Functional modules and API contracts', keys:['functionalModules','apis']},
  {title:'Business workflows and data movement', keys:['businessFlows','dataFlows']},
  {title:'Database design and security', keys:['databaseDesign','security']},
  {title:'Errors and quality attributes', keys:['errorHandling','nonFunctionalArchitecture']},
  {title:'Deployment and Jira traceability', keys:['deploymentArchitecture','traceability']},
  {title:'Decisions and implementation order', keys:['architecturalDecisions','implementationSequence']}
];

function compactJira(raw: any) {
  const epics = Array.isArray(raw) ? raw : list(pick(raw?.epics, raw?.data, raw?.items));
  return epics.filter(isObj).map(e => ({
    key:s(pick(e.key,e.epic_key,e.id)),
    name:short(pick(e.summary,e.name,e.title),120),
    stories:list(pick(e.stories,e.issues,e.children)).filter(isObj).map(st => ({
      key:s(pick(st.key,st.id)), summary:short(pick(st.summary,st.title,st.name),160),
      description:short(st.description,250),
      acceptanceCriteria:list(pick(st.acceptanceCriteria,st.acceptance_criteria)).slice(0,3).map(x=>short(isObj(x)?pick(x.description,x.criterion,x.text):x,140))
    }))
  }));
}
function compactErd(raw: any) {
  const d = isObj(raw?.erd) ? raw.erd : raw;
  return {
    entities:list(pick(d?.entities,d?.tables,d?.models)).map(e => typeof e === 'string' ? {name:e} : ({
      name:s(pick(e?.name,e?.entity,e?.table)),
      attributes:list(pick(e?.attributes,e?.fields,e?.columns)).slice(0,14).map(a=>typeof a==='string'?a:short(pick(a?.name,a?.field,a?.column),80))
    })).filter(e=>e.name),
    relationships:list(pick(d?.relationships,d?.relations,d?.associations)).map(r=>typeof r==='string'?r:{
      from:s(pick(r?.from,r?.source,r?.entity1)), to:s(pick(r?.to,r?.target,r?.entity2)),
      type:s(pick(r?.type,r?.cardinality))
    })
  };
}
function compactFrd(raw: any) {
  return {
    projectSummary:raw?.projectSummary ?? '',
    requirements:list(raw?.functionalRequirements).map(r=>({
      sectionId:r?.sectionId, storyKeys:list(r?.storyKeys), content:short(r?.content,650)
    })),
    traceability:list(raw?.traceability).slice(0,70),
    coverageWarnings:list(raw?.coverageWarnings).slice(0,20)
  };
}
function guidanceFromTemplate(template: string): string {
  // The external file remains the source of architecture instructions. Exclude its
  // huge empty example schema and embedded input placeholders from every batch.
  const firstInput = template.search(/INPUT\s*1\s*:\s*JIRA|__JIRA_TEXT__/i);
  const header = (firstInput >= 0 ? template.slice(0, firstInput) : template).trim();
  return header.slice(0, 6500);
}
function parseJson(raw: string): Obj {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  try { const obj=JSON.parse(cleaned); if(isObj(obj)) return obj; } catch { /* fallback */ }
  const start=cleaned.indexOf('{'), end=cleaned.lastIndexOf('}');
  if(start<0 || end<=start) throw new Error('Model response has no complete JSON object');
  const obj=JSON.parse(cleaned.slice(start,end+1));
  if(!isObj(obj)) throw new Error('Model response must be a JSON object');
  return obj;
}
async function callLLM(prompt: string, batch: number): Promise<Obj> {
  const ollama = /\/api\/chat\/?(?:\?|$)/.test(URL);
  const controller = new AbortController();
  const timer=setTimeout(()=>controller.abort(),600_000);
  try {
    const payload = ollama ? {
      model:MODEL, stream:false, format:'json',
      messages:[{role:'system',content:'You are a senior software architect. Return JSON only. Populate every requested field with specific facts or justified architecture decisions; never copy blank examples.'},{role:'user',content:prompt}],
      options:{temperature:0.2,num_ctx:Number(process.env.OLLAMA_NUM_CTX || 8192),num_predict:4096}
    } : {
      model:MODEL, temperature:0.2,
      messages:[{role:'system',content:'You are a senior software architect. Return valid, populated JSON only.'},{role:'user',content:prompt}]
    };
    const response=await fetch(URL,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json',...(!ollama && API_KEY?{Authorization:`Bearer ${API_KEY}`}:{})},body:json(payload)});
    const body=await response.text();
    if(!response.ok) throw new Error(`LLM HTTP ${response.status}: ${body.slice(0,1000)}`);
    const result=JSON.parse(body);
    const raw=ollama?result?.message?.content:result?.choices?.[0]?.message?.content;
    if(typeof raw!=='string'||!raw.trim()) throw new Error('Model returned empty response');
    await writeFile(path.join(OUT,`system_design_batch_${batch}_raw.txt`),raw,'utf8');
    return parseJson(raw);
  } finally {clearTimeout(timer);}
}
function meaningful(v: unknown): boolean {
  if(typeof v==='string') return v.trim().length>0;
  if(Array.isArray(v)) return v.some(meaningful);
  if(isObj(v)) return Object.values(v).some(meaningful);
  return false;
}
function validateBatch(data: Obj, keys: string[]) {
  for(const key of keys) {
    if(!(key in data)) throw new Error(`Missing section ${key}`);
    if(!meaningful(data[key])) throw new Error(`Section ${key} is empty`);
  }
  if(keys.includes('systemOverview') && !s(data.systemOverview?.systemName)) throw new Error('systemOverview.systemName is empty');
  if(keys.includes('architecture') && !list(data.architecture?.components).some(c=>s(c?.name))) throw new Error('No named architecture components');
  if(keys.includes('functionalModules') && !list(data.functionalModules).some(m=>s(m?.name))) throw new Error('No named functional modules');
  if(keys.includes('databaseDesign') && !list(data.databaseDesign?.entities).some(e=>s(e?.name))) throw new Error('No named database entities');
}
function validateAll(d: Obj) {
  for(const key of REQUIRED) if(!(key in d)||!meaningful(d[key])) throw new Error(`Missing or empty final section: ${key}`);
  if(!s(d.systemOverview?.systemName)) throw new Error('Empty system name');
  if(!list(d.architecture?.components).some(c=>s(c?.name))) throw new Error('No named architecture components');
  if(!list(d.functionalModules).some(m=>s(m?.name))) throw new Error('No named functional modules');
}
function batchPrompt(guidance: string, group: {title:string;keys:string[]}, jira: any, erd: any, frd: any): string {
  // Compact inputs are included in each request. Cap FRD text per batch to keep
  // llama3.2:3b from copying the original 170k-character template.
  const compact: any = {jira:{epics:jira},erd,frd};
  const inputText=json(compact);
  const maxChars=Number(process.env.SYSTEM_DESIGN_INPUT_CHARS || 17000);
  // Keep complete JSON when it fits; otherwise use progressively shorter story/FRD details.
  if(inputText.length>maxChars){
    compact.jira.epics=jira.map((e:any)=>({...e,stories:e.stories.map((st:any)=>({key:st.key,summary:st.summary}))}));
    compact.frd={projectSummary:frd.projectSummary,requirements:frd.requirements.map((r:any)=>({sectionId:r.sectionId,storyKeys:r.storyKeys,content:short(r.content,130)}))};
  }
  const examples:Record<string,unknown>={
    systemOverview:{systemName:'string',purpose:'string',architectureStyle:'string',architecturalRationale:'string',description:'string'},
    actors:[{name:'string',responsibility:'string',interactions:['string']}],
    architecture:{components:[{name:'string',type:'string',responsibility:'string',whyItExists:'string',dependencies:['component name'],ownedData:['entity name'],operations:['string']}],communicationPatterns:['string']},
    functionalModules:[{name:'string',purpose:'string',jiraEpics:['epic key'],jiraStories:['story key'],responsibilities:['string'],erdEntities:['entity name']}],
    apis:[{method:'GET|POST|PUT|DELETE',endpoint:'/api/example',purpose:'string',module:'string',request:'string',response:'string',authentication:'string',authorization:'string',validation:['string'],errors:['string']}],
    businessFlows:[{name:'string',actor:'string',steps:['string'],components:['string'],validations:['string'],databaseOperations:['string'],result:'string'}],
    dataFlows:[{name:'string',steps:['string'],dataEntities:['string'],consistency:'string'}],
    databaseDesign:{entities:[{name:'string',purpose:'string',keyAttributes:['string'],owningModule:'string'}],relationships:[],transactions:['string'],integrityConstraints:['string'],indexes:['string']},
    security:{authentication:'string',authorization:'string',roles:['string'],credentialProtection:'string',tokenManagement:'string',apiSecurity:['string'],dataProtection:['string']},
    errorHandling:[{failure:'string',detection:'string',response:'string',recovery:'string'}],
    nonFunctionalArchitecture:{performance:['string'],scalability:['string'],availability:['string'],reliability:['string'],maintainability:['string'],observability:['string']},
    deploymentArchitecture:{components:['string'],environments:['string'],communication:['string']},
    traceability:[{jiraEpic:'epic key',jiraStory:'story key',module:'string',api:'string',erdEntities:['entity name']}],
    architecturalDecisions:[{decision:'string',rationale:'string',consequence:'string'}],
    implementationSequence:['string']
  };
  const schema=Object.fromEntries(group.keys.map(k=>[k,examples[k]]));
  return `${guidance}\n\nTASK: ${group.title}. Generate ONLY the following top-level JSON keys: ${group.keys.join(', ')}.\n\nINPUTS (from existing local files):\n${json(compact)}\n\nOUTPUT SHAPE (type hints only; replace ALL sample values with specific, meaningful content):\n${json(schema)}\n\nCRITICAL: Never return an empty template. Use actual Jira epic/story keys, ERD entity names and FRD requirements. Provide realistic, grounded architecture decisions. If a design choice is inferred, describe it as proposed rather than existing. Return one valid JSON object and nothing else.`;
}
const label=(v:unknown)=>short(v,95).replace(/"/g,"'").replace(/[<>]/g,'');
function mermaidDesign(d:Obj):string {
  const lines:string[]=["%%{init: {'theme': 'base', 'flowchart': {'htmlLabels': false, 'nodeSpacing': 65, 'rankSpacing': 90}}}%%",'flowchart TB'];
  const actors=list(d.actors).filter(a=>s(a?.name));
  const comps=list(d.architecture?.components).filter(c=>s(c?.name));
  const db=list(d.databaseDesign?.entities).filter(e=>s(e?.name));
  const map=new Map<string,string>();
  const dbMap=new Map<string,string>();
  lines.push('subgraph CLIENT["Client Layer"]');
  actors.forEach((a,i)=>lines.push(`A${i}["${label(a.name)}"]`));
  lines.push('end','subgraph APPLICATION["Application Layer"]');
  comps.forEach((c,i)=>{const id=`C${i}`;map.set(s(c.name).toLowerCase(),id);lines.push(`${id}["${label(c.name)}"]`);});
  lines.push('end','subgraph DATABASE["Data Layer"]');
  db.forEach((e,i)=>{const id=`D${i}`;dbMap.set(s(e.name).toLowerCase(),id);lines.push(`${id}[("${label(e.name)}")]`);});
  lines.push('end');
  const edges=new Set<string>();
  if(comps.length) actors.forEach((_,i)=>edges.add(`A${i} --> C0`));
  comps.forEach((c,i)=>{
    list(c.dependencies).forEach(dep=>{const target=map.get(s(isObj(dep)?pick(dep.name,dep.component):dep).toLowerCase());if(target&&target!==`C${i}`)edges.add(`C${i} --> ${target}`);});
    list(c.ownedData).forEach(e=>{const target=dbMap.get(s(e).toLowerCase());if(target)edges.add(`C${i} --> ${target}`);});
  });
  list(d.databaseDesign?.relationships).forEach(r=>{
    const a=dbMap.get(s(pick(r?.from,r?.source)).toLowerCase());
    const b=dbMap.get(s(pick(r?.to,r?.target)).toLowerCase());
    if(a&&b&&a!==b)edges.add(`${a} -.-> ${b}`);
  });
  // Keep disconnected components visible rather than inventing edges.
  lines.push(...edges,'classDef actor fill:#e8f0fe,stroke:#333','classDef component fill:#e8f5e9,stroke:#333','classDef database fill:#fff3e0,stroke:#333');
  actors.forEach((_,i)=>lines.push(`class A${i} actor`));
  comps.forEach((_,i)=>lines.push(`class C${i} component`));
  db.forEach((_,i)=>lines.push(`class D${i} database`));
  return lines.join('\n')+'\n';
}
async function renderPNG() {
  const cli=path.join(BASE,'node_modules','@mermaid-js','mermaid-cli','src','cli.js');
  if(!existsSync(cli)) throw new Error('Mermaid CLI missing: npm.cmd install --save-dev @mermaid-js/mermaid-cli');
  await new Promise<void>((resolve,reject)=>{
    const child=spawn(process.execPath,[cli,'-i',MERMAID,'-o',PNG,'-b','white','-s','3'],{cwd:BASE,stdio:'inherit',shell:false});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve():reject(new Error(`Mermaid CLI exit code ${code}`)));
  });
  if(!existsSync(PNG)) throw new Error('PNG was not created');
}
async function main() {
  console.log('SYSTEM DESIGN GENERATOR — batched, validated, local JSON only');
  for(const file of [JIRA,ERD,FRD,PROMPT_PATH]) if(!existsSync(file)) throw new Error(`Required input missing: ${file}. No downloads or other generators will run.`);
  const [jiraRaw,erdRaw,frdRaw,template]=await Promise.all([readJson(JIRA),readJson(ERD),readJson(FRD),readFile(PROMPT_PATH,'utf8')]);
  if(!template.trim() || !['__JIRA_TEXT__','__ERD_TEXT__','__FRD_TEXT__'].every(x=>template.includes(x))) throw new Error('External prompt is empty or missing input placeholders');
  const jira=compactJira(jiraRaw),erd=compactErd(erdRaw),frd=compactFrd(frdRaw);
  if(!jira.length || !erd.entities.length || !isObj(frdRaw)||!Object.keys(frdRaw).length) throw new Error('Missing epics, ERD entities, or FRD content');
  await mkdir(OUT,{recursive:true});
  console.log(`Epics: ${jira.length}; ERD entities: ${erd.entities.length}; batches: ${GROUPS.length}; model: ${MODEL}`);
  const guidance=guidanceFromTemplate(template);
  const result:Obj={};
  for(let i=0;i<GROUPS.length;i++) {
    const group=GROUPS[i];
    console.log(`\nBatch ${i+1}/${GROUPS.length}: ${group.title}`);
    const prompt=batchPrompt(guidance,group,jira,erd,frd);
    console.log(`Prompt characters: ${prompt.length}`);
    let valid=false;
    for(let attempt=1;attempt<=2;attempt++) {
      try {
        const response=await callLLM(prompt+(attempt===2?'\nIMPORTANT: Your previous attempt was empty or invalid. Populate EVERY requested section with specific non-empty information.':''),i+1);
        validateBatch(response,group.keys);
        for(const key of group.keys) result[key]=response[key];
        valid=true;break;
      } catch(e) {
        console.error(`Batch ${i+1}, attempt ${attempt}:`,e);
        if(attempt===2) throw new Error(`Stopped: ${group.title} did not produce valid architecture. Existing outputs were not overwritten.`);
      }
    }
    if(!valid) throw new Error(`Batch ${i+1} failed`);
  }
  validateAll(result);
  // Only publish the final files after every batch passes validation.
  await writeFile(DESIGN,json(result),'utf8');
  await writeFile(MERMAID,mermaidDesign(result),'utf8');
  console.log('Saved validated JSON and Mermaid. Rendering PNG...');
  await renderPNG();
  console.log(`DONE\n${DESIGN}\n${MERMAID}\n${PNG}`);
  console.log(`Components: ${list(result.architecture?.components).length}, Modules: ${list(result.functionalModules).length}, Entities: ${list(result.databaseDesign?.entities).length}`);
}
main().catch(e=>{console.error('System design failed:',e);process.exitCode=1;});
