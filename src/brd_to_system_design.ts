import 'dotenv/config';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// Project root: BRD_TS (even when this script is inside BRD_TS/src)
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.basename(HERE).toLowerCase() === 'src' ? path.dirname(HERE) : HERE;
const OUT = path.join(BASE, 'system_design_output');
const JIRA = path.join(BASE, 'jira_erd_output', 'jira_epics_and_stories.json');
const ERD = path.join(BASE, 'jira_erd_output', 'erd.json');
const DESIGN = path.join(OUT, 'system_design.json');
const MERMAID = path.join(OUT, 'system_design.mmd');
const PNG = path.join(OUT, 'system_design.png');
const LLM_URL = process.env.LLM_URL || 'http://localhost:11434/api/chat';
const MODEL = process.env.MODEL || 'llama3.2:3b';
const API_KEY = process.env.LLM_API_KEY;

type Obj = Record<string, any>;
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): any[] => Array.isArray(v) ? v : [];
const first = (...items: any[]) => items.find(x => x !== undefined && x !== null && x !== '') ?? '';
const str = (v: any) => v === null || v === undefined ? '' : String(v).trim();
const section = (s: string) => console.log(`\n${'='.repeat(75)}\n${s}\n${'='.repeat(75)}`);
const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const saveJson = async (p: string, v: any) => writeFile(p, JSON.stringify(v, null, 2), 'utf8');
const shorten = (v: any, n = 500) => { const t = str(v).replace(/\s+/g, ' '); return t.length <= n ? t : t.slice(0,n).trimEnd()+'...'; };
const criteria = (v: any): string[] => (typeof v === 'string' ? [v] : arr(v)).map(x => typeof x === 'string' ? x : object(x) ? first(x.criterion,x.description,x.text) : '').map(x => shorten(x,250)).filter(Boolean).slice(0,5);

function compactJira(data: any) {
  const epics = Array.isArray(data) ? data : arr(first(data?.epics,data?.data,data?.items));
  return epics.filter(object).map(epic => ({
    key: str(first(epic.key,epic.epic_key,epic.id)),
    name: shorten(first(epic.summary,epic.epic_summary,epic.name,epic.title,'Unnamed Epic'),150),
    stories: arr(first(epic.stories,epic.issues,epic.children)).filter(object).map(story => ({
      key: str(first(story.key,story.id)),
      summary: shorten(first(story.summary,story.title,story.name),200),
      description: shorten(story.description,400),
      acceptanceCriteria: criteria(first(story.acceptanceCriteria,story.acceptance_criteria,story.acceptanceCriteriaList))
    }))
  }));
}
function compactErd(data: any) {
  const source = object(data?.erd) ? data.erd : data;
  const entities = Array.isArray(source) ? source : arr(first(source?.entities,source?.tables,source?.models));
  const relations = Array.isArray(source) ? [] : arr(first(source?.relationships,source?.relations,source?.associations));
  return {
    entities: entities.flatMap(e => typeof e === 'string' ? [{name:e}] : object(e) ? [{name:str(first(e.name,e.entity,e.table,e.title)),attributes:arr(first(e.attributes,e.fields,e.columns)).map(a => typeof a === 'string' ? a : object(a) ? first(a.name,a.field,a.column) : '').filter(Boolean).slice(0,20)}] : []).filter(e=>e.name),
    relationships: relations.map(r => typeof r === 'string' ? r : ({from:str(first(r.from,r.source,r.entity1)),to:str(first(r.to,r.target,r.entity2)),type:str(first(r.type,r.cardinality))}))
  };
}

async function run(cmd: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {

        const isWindows = process.platform === "win32";

        const child = isWindows
            ? spawn(
                "cmd.exe",
                ["/d", "/c", `${cmd} ${args.map(arg => `"${arg}"`).join(" ")}`],
                {
                    cwd: BASE,
                    stdio: "inherit",
                    windowsHide: true
                }
            )
            : spawn(cmd, args, {
                cwd: BASE,
                stdio: "inherit"
            });

        child.on("error", reject);

        child.on("close", code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`${cmd} exited with code ${code}`));
            }
        });
    });
}
async function ensureFile(file: string, generator: string) {
  if(existsSync(file)) {console.log('Using existing:',file);return;}
  const source=path.join(BASE,'src',generator);
  if(!existsSync(source)) throw new Error(`Missing ${file}. Generator not found: ${source}`);
  console.log(`Missing ${file}; running ${generator}...`);
  await run(process.platform==='win32'?'npx.cmd':'npx',['tsx',source]);
  if(!existsSync(file)) throw new Error(`${generator} completed without creating ${file}. Check its output paths.`);
}

// Original Python architecture prompt is embedded below without shortening its rules.
function buildPrompt(input: Obj): string {
  const jiraText=JSON.stringify(input.jira,null,2);
  const erdText=JSON.stringify(input.erd,null,2);
  return SYSTEM_PROMPT.replace('__JIRA_TEXT__',jiraText).replace('__ERD_TEXT__',erdText);
}

async function callLLM(prompt: string): Promise<string> {
  section('Generating System Design');
  console.log('Model:',MODEL,'URL:',LLM_URL);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),600_000);
  try {
    const isOllama = /\/api\/chat\/?(?:\?|$)/.test(LLM_URL);
    const payload = isOllama ? {
      model:MODEL, messages:[{role:'system',content:'You are a senior enterprise software architect. Produce precise, structured architecture models. Return valid JSON only.'},{role:'user',content:prompt}],
      format:'json',stream:false,options:{temperature:0.15,num_ctx:16384,num_predict:8192}
    } : {
      model:MODEL,messages:[{role:'system',content:'You are a senior enterprise software architect. Return valid JSON only.'},{role:'user',content:prompt}],temperature:0.15
    };
    const response=await fetch(LLM_URL,{method:'POST',signal:controller.signal,headers:{'Content-Type':'application/json','Accept':'application/json',...(!isOllama && API_KEY?{'Authorization':`Bearer ${API_KEY}`}:{})},body:JSON.stringify(payload)});
    const raw=await response.text();
    if(!response.ok) throw new Error(`LLM HTTP ${response.status}: ${raw.slice(0,1500)}`);
    const result=JSON.parse(raw);
    const content=isOllama?result?.message?.content:result?.choices?.[0]?.message?.content;
    if(typeof content!=='string'||!content.trim()) throw new Error('LLM returned empty message content');
    return content;
  } finally {clearTimeout(timeout);}
}

async function extractJson(raw: string): Promise<Obj> {
  await writeFile(path.join(OUT,'system_design_raw.txt'),raw,'utf8');
  let text=raw.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'').trim();
  console.log('LLM response preview:\n',text.slice(0,3000));
  try {return JSON.parse(text);} catch(err) {console.log('Direct JSON parsing failed:',String(err));}
  const start=text.indexOf('{'), end=text.lastIndexOf('}');
  if(start<0||end<start) throw new Error('LLM response does not contain a JSON object');
  text=text.slice(start,end+1);
  try {return JSON.parse(text);} catch(err) {
    console.error('Extracted JSON invalid:',String(err));
    throw new Error('Invalid LLM JSON; inspect system_design_output/system_design_raw.txt');
  }
}
const REQUIRED=['systemOverview','actors','architecture','functionalModules','apis','businessFlows','dataFlows','databaseDesign','security','errorHandling','nonFunctionalArchitecture','deploymentArchitecture','traceability','architecturalDecisions','implementationSequence'];
function validate(data: Obj) {if(!object(data))throw new Error('System design must be a JSON object'); const missing=REQUIRED.filter(k=>!(k in data));if(missing.length)throw new Error('Missing system design sections: '+missing.join(', '));}

const label=(v:any)=>str(v).replace(/"/g,"'").replace(/[\r\n]/g,' ').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function mermaidDesign(d: Obj): string {
  const lines:string[]=["%%{init: {'theme': 'base', 'flowchart': {'htmlLabels': true, 'curve': 'basis', 'nodeSpacing': 80, 'rankSpacing': 100}, 'themeVariables': {'fontSize': '20px', 'fontFamily': 'Arial'}}}%%",'flowchart TB',''];
  const actorIds:string[]=[];
  lines.push('    subgraph CLIENT["Client Layer"]');
  arr(d.actors).forEach((a,i)=>{if(!object(a))return;const id=`ACTOR_${i+1}`;actorIds.push(id);lines.push(`        ${id}["${label(first(a.name,`Actor ${i+1}`))}"]`);});
  lines.push('    end','','    subgraph APPLICATION["Application Layer"]');
  const components=arr(d.architecture?.components);const componentMap=new Map<string,string>();
  components.forEach((c,i)=>{if(!object(c))return;const id=`COMP_${i+1}`,name=str(first(c.name,`Component ${i+1}`));componentMap.set(name.toLowerCase(),id);const desc=str(c.responsibility);lines.push(`        ${id}["${label(name)}${desc?`<br/><span style='font-size:16px'>${label(desc.slice(0,80))}</span>`:''}"]`);});
  lines.push('    end','','    subgraph DATABASE["Data Layer"]');
  const entityMap=new Map<string,string>();
  arr(d.databaseDesign?.entities).forEach((e,i)=>{if(!object(e))return;const id=`DB_${i+1}`,name=str(first(e.name,`Entity ${i+1}`));entityMap.set(name.toLowerCase(),id);lines.push(`        ${id}["${label(name)}"]`);});
  lines.push('    end','');
  const infrastructure=arr(d.deploymentArchitecture?.components);
  if(infrastructure.length){lines.push('    subgraph INFRA["Infrastructure / External Layer"]');infrastructure.forEach((x,i)=>lines.push(`        INFRA_${i+1}["${label(typeof x==='string'?x:JSON.stringify(x))}"]`));lines.push('    end','');}
  const firstComponent=componentMap.values().next().value;
  if(firstComponent)actorIds.forEach(id=>lines.push(`    ${id} --> ${firstComponent}`));
  components.forEach((c,i)=>{if(!object(c))return;const id=`COMP_${i+1}`;const deps=typeof c.dependencies==='string'?[c.dependencies]:arr(c.dependencies);deps.forEach(x=>{const dest=componentMap.get(str(x).toLowerCase());if(dest&&dest!==id)lines.push(`    ${id} --> ${dest}`);});const owned=typeof c.ownedData==='string'?[c.ownedData]:arr(c.ownedData);owned.forEach(x=>{const dest=entityMap.get(str(x).toLowerCase());if(dest)lines.push(`    ${id} --> ${dest}`);});});
  arr(d.databaseDesign?.relationships).forEach(r=>{if(!object(r))return;const a=entityMap.get(str(r.from).toLowerCase()),b=entityMap.get(str(r.to).toLowerCase());if(a&&b)lines.push(`    ${a} -.-> ${b}`);});
  lines.push('','    classDef actor fill:#e8f0fe,stroke:#333','    classDef component fill:#e8f5e9,stroke:#333','    classDef database fill:#fff3e0,stroke:#333','    classDef infra fill:#f3e5f5,stroke:#333');
  actorIds.forEach(id=>lines.push(`    class ${id} actor`));
  componentMap.forEach(id=>lines.push(`    class ${id} component`));
  entityMap.forEach(id=>lines.push(`    class ${id} database`));
  infrastructure.forEach((_,i)=>lines.push(`    class INFRA_${i+1} infra`));
  return lines.join('\n')+'\n';
}
async function renderPNG(): Promise<void> {
    section("Generating System Design PNG");

    const mermaidCLI = path.join(
        BASE,
        "node_modules",
        "@mermaid-js",
        "mermaid-cli",
        "src",
        "cli.js"
    );

    if (!existsSync(mermaidCLI)) {
        throw new Error(
            "Mermaid CLI not found. Run: npm.cmd install --save-dev @mermaid-js/mermaid-cli"
        );
    }

    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                mermaidCLI,
                "-i", MERMAID,
                "-o", PNG,
                "-b", "white",
                "-s", "3"
            ],
            {
                cwd: BASE,
                stdio: "inherit",
                shell: false
            }
        );

        child.on("error", reject);

        child.on("close", code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Mermaid CLI exited with code ${code}`));
            }
        });
    });

    if (!existsSync(PNG)) {
        throw new Error("Mermaid CLI completed but PNG was not created.");
    }

    console.log("PNG saved:", PNG);
}
function summary(d: Obj){section('SYSTEM DESIGN SUMMARY');console.log('System:',d.systemOverview?.systemName??'');console.log('Architecture:',d.systemOverview?.architectureStyle??'');console.log('Components:',arr(d.architecture?.components).length);console.log('Functional modules:',arr(d.functionalModules).length);console.log('APIs:',arr(d.apis).length);console.log('Business flows:',arr(d.businessFlows).length);console.log('Database entities:',arr(d.databaseDesign?.entities).length);}

async function main() {
  await mkdir(OUT, { recursive: true });
  section('AI SYSTEM DESIGN GENERATOR');
  const regenerate = process.argv.includes('--regenerate');
  console.log('Mode:', regenerate ? 'regenerate all outputs' : 'reuse existing outputs');

  let design: Obj;
  let createdDesign = false;

  if (!regenerate && existsSync(DESIGN)) {
    section('Reusing Existing System Design');
    design = await readJson(DESIGN);
    validate(design);
    console.log('Using existing:', DESIGN);
  } else {
    // Only load Jira/ERD and call Ollama if the design JSON is missing
    // or regeneration was explicitly requested.
    if (!existsSync(JIRA)) {
      throw new Error(`Missing ${JIRA}. Run your Jira-to-ERD exporter first.`);
    }
    await ensureFile(ERD, 'brd_to_erd.ts');
    const jira = await readJson(JIRA);
    const erd = await readJson(ERD);
    const input = { jira: { epics: compactJira(jira) }, erd: compactErd(erd) };
    section('Preparing System Design Input');
    console.log('Epics:', input.jira.epics.length,
      'Stories:', input.jira.epics.reduce((n, e) => n + e.stories.length, 0),
      'ERD entities:', input.erd.entities.length,
      'Relationships:', input.erd.relationships.length);
    const prompt = buildPrompt(input);
    console.log('Prompt size:', prompt.length);
    const raw = await callLLM(prompt);
    design = await extractJson(raw);
    validate(design);
    await saveJson(DESIGN, design);
    createdDesign = true;
    console.log('Saved:', DESIGN);
  }

  const createMermaid = createdDesign || !existsSync(MERMAID);
  if (createMermaid) {
    await writeFile(MERMAID, mermaidDesign(design), 'utf8');
    console.log('Saved:', MERMAID);
  } else {
    console.log('Using existing:', MERMAID);
  }

  if (createMermaid || !existsSync(PNG)) {
    await renderPNG();
  } else {
    console.log('Using existing:', PNG);
  }

  summary(design);
  section('SYSTEM DESIGN COMPLETE');
  console.log(DESIGN, '\n', MERMAID, '\n', PNG);
}

const SYSTEM_PROMPT = "You are a Senior Solution Architect and Enterprise Application Architect.\n\nYour task is to design a complete, production-oriented SYSTEM DESIGN for the software system described by the provided Jira Epics, Jira Stories, and ERD.\n\nThe Jira Epics and Stories represent the functional business requirements.\nThe ERD represents the persistent data model.\nYour responsibility is to transform these requirements into a coherent technical architecture.\n\nIMPORTANT:\n\n* Do NOT merely summarize the Jira stories.\n* Do NOT copy Jira story descriptions or acceptance criteria verbatim.\n* Do NOT invent business requirements that are not supported by the input.\n* You MAY introduce necessary technical components such as API layers, authentication, authorization, validation, service layers, repositories, transaction boundaries, logging, monitoring, caching, messaging, and deployment components when they are architecturally justified.\n* Every major functional capability must be traceable back to Jira requirements.\n* Database entities and relationships must remain consistent with the supplied ERD.\n* Prefer a modular, maintainable architecture suitable for enterprise implementation.\n* Make reasonable architectural decisions where the requirements do not explicitly specify implementation details, but clearly state those decisions.\n\nINPUT 1: JIRA EPICS AND STORIES\n__JIRA_TEXT__\n\nINPUT 2: ERD\n__ERD_TEXT__\n\nBased on these inputs, generate the SYSTEM DESIGN using the following structure.\n\nReturn ONLY valid JSON.\nDo not return Markdown.\nDo not add explanations before or after the JSON.\n\n{\n\"systemOverview\": {\n\"systemName\": \"\",\n\"purpose\": \"\",\n\"architectureStyle\": \"\",\n\"architecturalRationale\": \"\",\n\"description\": \"\"\n},\n\n\"actors\": [\n{\n\"name\": \"\",\n\"responsibility\": \"\",\n\"interactions\": []\n}\n],\n\n\"architecture\": {\n\"components\": [\n{\n\"name\": \"\",\n\"type\": \"\",\n\"responsibility\": \"\",\n\"whyItExists\": \"\",\n\"dependencies\": [],\n\"ownedData\": [],\n\"operations\": []\n}\n],\n\"communicationPatterns\": []\n},\n\n\"functionalModules\": [\n{\n\"name\": \"\",\n\"purpose\": \"\",\n\"jiraEpics\": [],\n\"jiraStories\": [],\n\"responsibilities\": [],\n\"erdEntities\": []\n}\n],\n\n\"apis\": [\n{\n\"method\": \"\",\n\"endpoint\": \"\",\n\"purpose\": \"\",\n\"module\": \"\",\n\"request\": \"\",\n\"response\": \"\",\n\"authentication\": \"\",\n\"authorization\": \"\",\n\"validation\": [],\n\"errors\": []\n}\n],\n\n\"businessFlows\": [\n{\n\"name\": \"\",\n\"actor\": \"\",\n\"steps\": [],\n\"components\": [],\n\"validations\": [],\n\"databaseOperations\": [],\n\"result\": \"\"\n}\n],\n\n\"dataFlows\": [\n{\n\"name\": \"\",\n\"steps\": [],\n\"dataEntities\": [],\n\"consistency\": \"\"\n}\n],\n\n\"databaseDesign\": {\n\"entities\": [\n{\n\"name\": \"\",\n\"purpose\": \"\",\n\"keyAttributes\": [],\n\"owningModule\": \"\"\n}\n],\n\"relationships\": [],\n\"transactions\": [],\n\"integrityConstraints\": [],\n\"indexes\": []\n},\n\n\"security\": {\n\"authentication\": \"\",\n\"authorization\": \"\",\n\"roles\": [],\n\"credentialProtection\": \"\",\n\"tokenManagement\": \"\",\n\"apiSecurity\": [],\n\"dataProtection\": []\n},\n\n\"errorHandling\": [\n{\n\"failure\": \"\",\n\"detection\": \"\",\n\"response\": \"\",\n\"recovery\": \"\"\n}\n],\n\n\"nonFunctionalArchitecture\": {\n\"performance\": [],\n\"scalability\": [],\n\"availability\": [],\n\"reliability\": [],\n\"maintainability\": [],\n\"observability\": []\n},\n\n\"deploymentArchitecture\": {\n\"components\": [],\n\"environments\": [],\n\"communication\": []\n},\n\n\"traceability\": [\n{\n\"jiraEpic\": \"\",\n\"jiraStory\": \"\",\n\"module\": \"\",\n\"api\": \"\",\n\"erdEntities\": []\n}\n],\n\n\"architecturalDecisions\": [\n{\n\"decision\": \"\",\n\"rationale\": \"\",\n\"consequence\": \"\"\n}\n],\n\n\"implementationSequence\": []\n}\n\n\nARCHITECTURAL RULES\n\n1. SYSTEM OVERVIEW\n\nIdentify:\n\n* What the system does.\n* Its primary business purpose.\n* The recommended architecture style.\n* Why that architecture fits the requirements.\n* The major architectural characteristics.\n\nChoose an architecture style based on the requirements, such as:\n\n* Modular monolith\n* Layered architecture\n* Microservices\n* Event-driven architecture\n* Hybrid architecture\n\nDo not choose microservices merely because it is common.\nChoose the simplest architecture that adequately satisfies the requirements.\n\n2. ACTORS\n\nIdentify only meaningful actors supported by the requirements.\n\nExamples:\n\n* Student\n* Administrator\n* Librarian\n* External system\n* System scheduler\n\nFor each actor, explain what they actually do in the system.\n\n3. ARCHITECTURE COMPONENTS\n\nIdentify the major technical components required to implement the system.\n\nTypical components may include:\n\n* Web / Mobile Client\n* API Gateway\n* Authentication Module\n* User Management Module\n* Business/Application Services\n* Domain Modules\n* Validation Layer\n* Repository/Data Access Layer\n* Database\n* Cache\n* Message Broker\n* Notification Service\n* External Integrations\n* Logging/Monitoring\n\nOnly include components that are justified by the requirements.\n\nFor every component specify:\n\n* responsibility\n* reason for existence\n* dependencies\n* owned data\n* important operations\n\nDo not create a separate component for every Jira story.\n\nGroup related stories into meaningful business modules.\n\n4. FUNCTIONAL MODULES\n\nConvert Jira Epics and related Stories into logical application modules.\n\nFor example:\n\nAuthentication\nStudent Management\nBook Catalog\nBook Borrowing\nBook Return\nAdministration\nNotification\n\nEach module should contain:\n\n* purpose\n* related Jira Epics\n* related Jira Stories\n* responsibilities\n* ERD entities used by the module\n\nA module should represent a meaningful business capability rather than a single API.\n\n5. API DESIGN\n\nDerive the most important REST APIs required by the system.\n\nFor each API provide:\n\n* HTTP method\n* endpoint\n* purpose\n* owning module\n* request\n* response\n* authentication requirement\n* authorization requirement\n* validation\n* possible errors\n\nUse realistic REST conventions.\n\nDo not create unnecessary APIs for every internal operation.\n\n6. BUSINESS FLOWS\n\nDescribe the most important end-to-end business processes.\n\nExamples:\n\nUser Registration/Login\nBook Search\nBook Borrowing\nBook Return\nAdministrative Book Management\n\nFor each flow explain:\n\nActor\n→ API/UI\n→ Application Module\n→ Business Validation\n→ Database Operation\n→ Result\n\nInclude important business rules.\n\nFor example, if the requirements state that a student can acquire at most 3 books, the borrowing flow must explicitly show:\n\n1. Identify student.\n2. Check current active borrowing count.\n3. Validate the maximum borrowing limit.\n4. Check book availability.\n5. Create borrowing transaction.\n6. Update book availability.\n7. Return successful result.\n\nDo not invent business rules not supported by the input.\n\n7. DATA FLOWS\n\nExplain how important information moves through the system.\n\nExample:\n\nClient\n→ API\n→ Authentication\n→ Application Service\n→ Validation\n→ Repository\n→ Database\n→ Response\n\nFor each important flow identify:\n\n* participating components\n* data entities\n* consistency requirements\n\n8. DATABASE DESIGN\n\nUse the supplied ERD as the authoritative source for persistent entities and relationships.\n\nDo not contradict the ERD.\n\nFor every important entity identify:\n\n* purpose\n* key attributes\n* owning module\n\nAlso describe:\n\n* relationships\n* transaction boundaries\n* integrity constraints\n* useful indexes\n\nDo not invent attributes unless they are technically necessary and clearly justified.\n\n9. SECURITY\n\nDesign security appropriate for the system.\n\nConsider:\n\n* authentication\n* authorization\n* roles\n* password hashing\n* token management\n* API protection\n* input validation\n* sensitive data protection\n* least privilege\n* audit logging where appropriate\n\nDo not claim a specific security technology unless supported by the requirements or clearly state it as an architectural decision.\n\n10. ERROR HANDLING\n\nIdentify important failure scenarios.\n\nExamples:\n\n* Invalid credentials\n* Unauthorized access\n* Resource not found\n* Validation failure\n* Business rule violation\n* Duplicate data\n* Database failure\n* External service failure\n* Timeout\n* Unexpected application error\n\nFor each explain:\n\n* how failure is detected\n* API/system response\n* recovery or handling strategy\n\n11. NON-FUNCTIONAL ARCHITECTURE\n\nProvide realistic considerations for:\n\nPerformance\nScalability\nAvailability\nReliability\nMaintainability\nObservability\n\nDo not use generic statements such as \"the system should be fast.\"\n\nExplain the architectural mechanism where appropriate.\n\nExample:\n\n\"Database indexes should be created on frequently queried attributes such as student identifier and book identifier to reduce lookup latency.\"\n\n12. DEPLOYMENT ARCHITECTURE\n\nDescribe how the system would be deployed.\n\nInclude logical deployment components such as:\n\nClient\nAPI/Application Server\nDatabase\nCache\nMessage Broker\nExternal Services\nMonitoring\n\nDo not invent cloud-specific infrastructure unless required.\n\nKeep the deployment architecture implementation-neutral where possible.\n\n13. TRACEABILITY\n\nCreate explicit traceability between:\n\nJira Epic\n→ Jira Story\n→ Functional Module\n→ API\n→ ERD Entity\n\nEvery important business capability should be traceable.\n\nDo not lose Jira story identifiers.\n\n14. ARCHITECTURAL DECISIONS\n\nIdentify the most important architectural decisions.\n\nFor example:\n\n* Why modular monolith instead of microservices?\n* Why REST APIs?\n* Why centralized authentication?\n* Why transactional borrowing operation?\n* Why database indexing?\n* Why asynchronous processing for notifications?\n\nFor every decision explain:\n\n* decision\n* rationale\n* consequence/trade-off\n\nKeep this focused on meaningful architectural decisions.\n\n15. IMPLEMENTATION SEQUENCE\n\nProvide a logical implementation order.\n\nExample:\n\n1. Database schema\n2. Authentication and authorization\n3. Core domain modules\n4. Repository/data access\n5. REST APIs\n6. Business workflows\n7. External integrations\n8. Error handling\n9. Observability\n10. Deployment\n\nAdapt the sequence to the actual system.\n\nQUALITY REQUIREMENTS\n\nThe generated design must be:\n\n* Architecturally coherent.\n* Internally consistent.\n* Traceable to Jira.\n* Consistent with the ERD.\n* Implementation-oriented.\n* Suitable for a senior architect/business analyst presentation.\n* Detailed enough to guide developers.\n* Concise enough to remain readable.\n\nAvoid:\n\n* Generic filler.\n* Repeating Jira stories.\n* Repeating the ERD without architectural interpretation.\n* Creating unnecessary microservices.\n* Inventing unsupported business functionality.\n* Excessive technical jargon.\n* Long paragraphs.\n\nOUTPUT SIZE GUIDELINES\n\nKeep the response focused.\n\n* systemOverview descriptions: maximum 2–3 sentences.\n* Component responsibilities: maximum 2–3 sentences.\n* Business flow: maximum 8 steps.\n* Architectural decisions: maximum 3 sentences each.\n* API descriptions: concise.\n* Do not duplicate the same information across sections.\n\nThe final output must be valid JSON and must contain no Markdown or explanatory text outside the JSON.";

main().catch(err=>{console.error("System design failed:",err);process.exitCode=1;});
