/** Generate a database ERD from an existing local Epic/Story JSON file. */

import 'dotenv/config';

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';


import path from 'node:path';



const env = (name: string, fallback = '') => process.env[name] ?? fallback;
const LLM_URL = env('LLM_URL', 'https://api.apinex.bond/v1/chat/completions');
const LLM_API_KEY = env('LLM_API_KEY');
const LLM_MODEL = env('LLM_MODEL', 'free/gpt-6-luna');
const KROKI_URL = env('KROKI_URL', 'https://kroki.io/mermaid/png');


const OUTPUT_DIR = path.resolve('jira_erd_output');

const HIERARCHY_FILE = path.resolve('src', 'BRD_TO_STORY', 'epics_and_stories.json');
const PROMPT_FILE = path.resolve('src', 'ERD', 'erd_prompt.txt');

const ERD_FILE = path.join(OUTPUT_DIR, 'erd.json');

const MERMAID_FILE = path.join(OUTPUT_DIR, 'erd_diagram.mmd');

const PNG_FILE = path.join(OUTPUT_DIR, 'erd_diagram.png');

const RAW_FILE = path.join(OUTPUT_DIR, 'llm_raw_response.txt');



type AnyObject = Record<string, any>;

type Issue = { key: string; issue_type: string; summary: string; description: string; acceptance_criteria: string; parent_key: string | null; epic_link: string | null; status: string };

type Epic = { epic_key: string; epic_summary: string; epic_description: string; stories: Issue[] };

type Hierarchy = { project_key: string; epic_count: number; story_count: number; epics: Epic[] };

type Attribute = { name: string; type: string; primary_key: boolean; foreign_key: boolean };

type Entity = { name: string; description?: string; attributes: Attribute[] };

type Relationship = { from: string; to: string; label?: string; cardinality?: string };

type Erd = { entities: Entity[]; relationships: Relationship[]; assumptions?: string[] };



const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {

  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

}

async function loadHierarchy(): Promise<Hierarchy> {
  let raw: string;
  try {
    raw = await readFile(HIERARCHY_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Required Epic/Story JSON not found: ${HIERARCHY_FILE}. Generate it before running ERD generation; no Jira download will be attempted.`);
    }
    throw error;
  }
  let hierarchy: Hierarchy;
  try {
    hierarchy = JSON.parse(raw) as Hierarchy;
  } catch {
    throw new Error(`Invalid JSON in ${HIERARCHY_FILE}`);
  }
  if (!hierarchy || !Array.isArray(hierarchy.epics) || hierarchy.epics.length === 0 ||
      hierarchy.epics.some(epic => !Array.isArray(epic.stories))) {
    throw new Error(`Invalid Epic/Story hierarchy in ${HIERARCHY_FILE}: expected { epics: [{ stories: [...] }] }`);
  }
  console.log(`Using existing Epic/Story JSON: ${HIERARCHY_FILE}`);
  return hierarchy;
}

async function loadErdPrompt(): Promise<string> {
  let prompt: string;
  try {
    prompt = await readFile(PROMPT_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`ERD prompt file not found: ${PROMPT_FILE}`);
    }
    throw error;
  }
  if (!prompt.trim()) throw new Error(`ERD prompt is empty: ${PROMPT_FILE}`);
  return prompt.trim();
}

function stripJsonFences(content: string): string {

  return content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

}

function safeIdentifier(value: unknown, fallback = 'Entity'): string {

  let result = String(value ?? '').trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || fallback;

  if (/^\d/.test(result)) result = `T_${result}`;

  return result;

}

function mermaidType(value: unknown): string {

  const type = String(value ?? 'string').trim().toUpperCase();

  if (['INT', 'INTEGER', 'SMALLINT', 'BIGINT', 'SERIAL', 'BIGSERIAL'].includes(type)) return 'int';

  if (['BOOL', 'BOOLEAN'].includes(type)) return 'boolean';

  if (type === 'DATE') return 'date';

  if (type.includes('TIME')) return 'datetime';

  if (['DECIMAL', 'NUMERIC', 'NUMBER', 'FLOAT'].some(x => type.includes(x))) return 'decimal';

  if (['TEXT', 'VARCHAR', 'CHAR', 'STRING'].includes(type) || type.startsWith('VARCHAR') || type.startsWith('CHAR')) return 'string';

  return safeIdentifier(type, 'string').toLowerCase();

}

function buildDatabaseMermaid(erd: Erd): string {

  if (!Array.isArray(erd.entities) || erd.entities.length === 0) throw new Error('The ERD has no entities to render.');

  const ids = new Map<string, string>();

  const used = new Set<string>();

  for (const entity of erd.entities) {

    const original = String(entity.name ?? '').trim();

    if (!original) throw new Error('An ERD entity is missing its name.');

    const base = safeIdentifier(original);

    let identifier = base, suffix = 2;

    while (used.has(identifier.toLowerCase())) identifier = `${base}_${suffix++}`;

    used.add(identifier.toLowerCase());

    ids.set(original.toLowerCase(), identifier);

  }

  const lines = [

    '%%{init: {', '  "theme": "default",', '  "themeVariables": {',

    '    "background": "#ffffff",', '    "primaryColor": "#f4f7fb",',

    '    "primaryBorderColor": "#526d82",', '    "primaryTextColor": "#172b4d",',

    '    "lineColor": "#526d82",', '    "tertiaryColor": "#ffffff"',

    '  }', '}}%%', 'erDiagram', '    direction TB'

  ];

  const cardinalityMap: Record<string, string> = {

    'one-to-one': '||--||', 'one-to-many': '||--o{',

    'many-to-one': '}o--||', 'many-to-many': '}o--o{'

  };

  for (const rel of erd.relationships ?? []) {

    const from = ids.get(String(rel.from ?? '').trim().toLowerCase());

    const to = ids.get(String(rel.to ?? '').trim().toLowerCase());

    if (!from || !to) continue;

    const connector = cardinalityMap[String(rel.cardinality ?? 'one-to-many').toLowerCase()] ?? '||--o{';

    const label = String(rel.label ?? 'relates to').replace(/[^A-Za-z0-9_ ]/g, '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'relates to';

    lines.push(`    ${from} ${connector} ${to} : "${label}"`);

  }

  for (const entity of erd.entities) {

    const id = ids.get(entity.name.trim().toLowerCase())!;

    lines.push('', `    ${id} {`);

    if (!Array.isArray(entity.attributes) || entity.attributes.length === 0) {

      lines.push('        string schema_details');

    } else {

      const seen = new Set<string>();

      for (const attr of entity.attributes) {

        if (!attr || typeof attr !== 'object') continue;

        const column = safeIdentifier(attr.name ?? 'column', 'column').toLowerCase();

        if (seen.has(column)) continue;

        seen.add(column);

        const keys = [attr.primary_key === true ? 'PK' : '', attr.foreign_key === true ? 'FK' : ''].filter(Boolean);

        // Mermaid ER attribute key syntax uses comma-separated PK,FK.

        lines.push(`        ${mermaidType(attr.type)} ${column}${keys.length ? ` ${keys.join(',')}` : ''}`);

      }

    }

    lines.push('    }');

  }

  return `${lines.join('\n')}\n`;

}

function compactHierarchy(hierarchy: Hierarchy): AnyObject {

  return { project_key: hierarchy.project_key,

    epics: hierarchy.epics.map(epic => ({

      epic_summary: epic.epic_summary ?? '',

      epic_description: String(epic.epic_description ?? '').slice(0, 500),

      stories: epic.stories.map(story => ({

        summary: String(story.summary ?? '').slice(0, 180),

        description: String(story.description ?? '').slice(0, 450),

        acceptance_criteria: String(story.acceptance_criteria ?? '').slice(0, 300)

      }))

    })) };

}

async function generateErdAndMermaid(hierarchy: Hierarchy): Promise<[Erd, string]> {

  if (!LLM_API_KEY) throw new Error('Set LLM_API_KEY in your .env file.');

  const systemPrompt = await loadErdPrompt();
  const requirements = JSON.stringify(compactHierarchy(hierarchy));

  const payload = {

    model: LLM_MODEL, messages: [

      { role: 'system', content: systemPrompt },

      { role: 'user', content: 'Generate the database ERD JSON schema only for these combined Jira requirements. Include table columns, SQL-like data types, PK/FK flags, relationships and cardinalities:\n\n' + requirements }

    ], temperature: 0, max_tokens: 12000, response_format: { type: 'json_object' }

  };

  let generated: AnyObject | undefined;

  let lastError = '';

  for (let attempt = 1; attempt <= 3; attempt++) {

    try {

      console.log(`\nCalling LLM, attempt ${attempt}/3...`);

      const response = await request(LLM_URL, {

        method: 'POST', headers: { Authorization: `Bearer ${LLM_API_KEY}`, 'Content-Type': 'application/json' },

        body: JSON.stringify(payload)

      }, 240000);

      const body = await response.text();

      if (!response.ok) {

        const message = `LLM HTTP ${response.status}: ${body.slice(0, 1500)}`;

        if ([429, 500, 502, 503, 504, 524].includes(response.status)) throw new Error(message);

        throw Object.assign(new Error(message), { nonRetryable: true });

      }

      let result: AnyObject;

      try { result = JSON.parse(body); }

      catch (error) { await writeFile(RAW_FILE, body); throw new Error(`LLM returned a non-JSON HTTP response: ${String(error)}`); }

      const choice = result.choices?.[0];

      const content = choice?.message?.content;

      if (typeof content !== 'string' || !content.trim()) {

        await writeFile(RAW_FILE, JSON.stringify(result, null, 2));

        throw new Error(`LLM response missing choices[0].message.content; finish_reason=${choice?.finish_reason}; saved to ${RAW_FILE}`);

      }

      const cleaned = stripJsonFences(content);

      try { generated = JSON.parse(cleaned); }

      catch (error) {

        await writeFile(RAW_FILE, cleaned);

        throw new Error(`LLM returned invalid JSON; finish_reason=${choice?.finish_reason}; saved to ${RAW_FILE}: ${String(error)}`);

      }

      break;

    } catch (error) {

      lastError = error instanceof Error ? error.message : String(error);

      if ((error as AnyObject)?.nonRetryable || attempt === 3) throw new Error(`LLM generation failed: ${lastError}`);

      console.warn(`${lastError}; retrying...`);

      await sleep(attempt * 5000);

    }

  }

  if (!generated || typeof generated !== 'object') throw new Error(`Could not obtain valid ERD JSON: ${lastError}`);

  const erd = (generated.erd && typeof generated.erd === 'object' ? generated.erd : generated.entities ? generated : null) as Erd | null;

  if (!erd || !Array.isArray(erd.entities) || !Array.isArray(erd.relationships)) throw new Error('LLM output must include erd.entities and erd.relationships arrays.');

  const mermaid = buildDatabaseMermaid(erd);

  await writeFile(ERD_FILE, JSON.stringify(erd, null, 2), 'utf8');

  await writeFile(MERMAID_FILE, mermaid, 'utf8');

  console.log(`ERD JSON saved: ${ERD_FILE}\nMermaid source saved: ${MERMAID_FILE}`);

  console.log(`Entities generated: ${erd.entities.length}\nRelationships generated: ${erd.relationships.length}`);

  return [erd, mermaid.trim()];

}

async function renderMermaidPng(mermaidText: string): Promise<void> {

  console.log('\nSending Mermaid source to cloud renderer...');

  const response = await request(KROKI_URL, {

    method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'image/png' }, body: mermaidText

  }, 120000);

  const bytes = Buffer.from(await response.arrayBuffer());

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  if (!bytes.subarray(0, 8).equals(signature)) {

    throw new Error(`Cloud renderer did not return a valid PNG. HTTP ${response.status}; Content-Type: ${response.headers.get('content-type')}; response: ${bytes.toString('utf8').slice(0, 1500)}`);

  }

  if (response.status !== 200) console.warn(`Renderer returned HTTP ${response.status}, but response body is a valid PNG; saving anyway.`);

  await writeFile(PNG_FILE, bytes);

  console.log(`ER diagram PNG saved: ${PNG_FILE}\nPNG size: ${(await stat(PNG_FILE)).size.toLocaleString()} bytes`);

}

async function main(): Promise<void> {

  await mkdir(OUTPUT_DIR, { recursive: true });


  const hierarchy = await loadHierarchy();

  if (!hierarchy.epics?.length) throw new Error('No Epics found in the existing JSON.');

  console.log('\nGenerating ERD JSON and Mermaid using the LLM...');

  const [, mermaid] = await generateErdAndMermaid(hierarchy);

  console.log('\nRendering Mermaid in the cloud...');

  await renderMermaidPng(mermaid);

  console.log(`\nPipeline completed successfully.\nERD JSON: ${ERD_FILE}\nMermaid source: ${MERMAID_FILE}\nERD PNG: ${PNG_FILE}`);

}

main().catch(error => { console.error(error); process.exitCode = 1; });
