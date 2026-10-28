/** Python stories_ERD.py equivalent: Jira -> hierarchy -> LLM ERD -> Mermaid -> Kroki PNG.
 * Requires Node.js >= 20 and: npm install dotenv
 */
import 'dotenv/config';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const env = (name: string, fallback = '') => process.env[name] ?? fallback;
const JIRA_BASE_URL = env('JIRA_BASE_URL').replace(/\/+$/, '');
const JIRA_EMAIL = env('JIRA_EMAIL');
const JIRA_API_TOKEN = env('JIRA_API_TOKEN');
const PROJECT_KEY = env('JIRA_PROJECT_KEY', 'SCRUM');
const LLM_URL = env('LLM_URL', 'https://api.apinex.bond/v1/chat/completions');
const LLM_API_KEY = env('LLM_API_KEY');
const LLM_MODEL = env('LLM_MODEL', 'free/gpt-6-luna');
const KROKI_URL = env('KROKI_URL', 'https://kroki.io/mermaid/png');
const EPIC_LINK_FIELD = env('JIRA_EPIC_LINK_FIELD', 'customfield_10014');
const ACCEPTANCE_CRITERIA_FIELD = env('JIRA_ACCEPTANCE_CRITERIA_FIELD', 'customfield_10016');
const OUTPUT_DIR = path.resolve('jira_erd_output');
const HIERARCHY_FILE = path.join(OUTPUT_DIR, 'jira_epics_and_stories.json');
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
async function jiraSearchAll(jql: string, fields: string[]): Promise<AnyObject[]> {
  const issues: AnyObject[] = [];
  let nextPageToken: string | undefined;
  do {
    const payload: AnyObject = { jql, fields, maxResults: 100 };
    if (nextPageToken) payload.nextPageToken = nextPageToken;
    const response = await request(`${JIRA_BASE_URL}/rest/api/3/search/jql`, {
      method: 'POST', headers: {
        Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}`,
        Accept: 'application/json', 'Content-Type': 'application/json'
      }, body: JSON.stringify(payload)
    }, 90000);
    if (!response.ok) throw new Error(`Jira search HTTP ${response.status}: ${(await response.text()).slice(0, 1500)}`);
    const data = await response.json() as AnyObject;
    const page = Array.isArray(data.issues) ? data.issues : [];
    issues.push(...page);
    console.log(`Fetched ${page.length} issues; total = ${issues.length}`);
    nextPageToken = page.length ? data.nextPageToken : undefined;
  } while (nextPageToken);
  return issues;
}
function cleanText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(cleanText).join('\n');
  if (typeof value === 'object') {
    const obj = value as AnyObject;
    const parts = [typeof obj.text === 'string' ? obj.text : '', ...(Array.isArray(obj.content) ? obj.content.map(cleanText) : [])].filter(Boolean);
    return parts.join('\n');
  }
  return String(value);
}
function normalizeIssue(issue: AnyObject): Issue {
  const fields = issue.fields ?? {};
  const link = fields[EPIC_LINK_FIELD];
  return {
    key: issue.key ?? '', issue_type: fields.issuetype?.name ?? '',
    summary: fields.summary ?? '', description: cleanText(fields.description),
    acceptance_criteria: cleanText(fields[ACCEPTANCE_CRITERIA_FIELD]),
    parent_key: fields.parent?.key ?? null,
    epic_link: (typeof link === 'object' && link !== null ? link.key : link) ?? null,
    status: fields.status?.name ?? ''
  };
}
async function downloadEpicsAndStories(): Promise<Hierarchy> {
  console.log('\nDownloading Epics...');
  const epicFields = ['summary', 'description', 'issuetype', 'status', 'parent'];
  const rawEpics = await jiraSearchAll(`project = "${PROJECT_KEY}" AND issuetype = Epic ORDER BY key ASC`, epicFields);
  const epics = rawEpics.map(normalizeIssue);
  console.log(`\nFound ${epics.length} Epics.\nDownloading project issues...`);
  const fields = [...epicFields, EPIC_LINK_FIELD, ACCEPTANCE_CRITERIA_FIELD];
  const issues = (await jiraSearchAll(`project = "${PROJECT_KEY}" ORDER BY key ASC`, fields)).map(normalizeIssue);
  const hierarchy: Epic[] = epics.map(epic => ({
    epic_key: epic.key, epic_summary: epic.summary, epic_description: epic.description,
    stories: issues.filter(issue => issue.key !== epic.key && (issue.parent_key === epic.key || issue.epic_link === epic.key))
  }));
  const result: Hierarchy = { project_key: PROJECT_KEY, epic_count: epics.length,
    story_count: hierarchy.reduce((sum, epic) => sum + epic.stories.length, 0), epics: hierarchy };
  await writeFile(HIERARCHY_FILE, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\nSaved hierarchy: ${HIERARCHY_FILE}\nEpics: ${result.epic_count}\nAssociated issues: ${result.story_count}`);
  return result;
}
async function loadHierarchy(): Promise<Hierarchy> {
  if (!existsSync(HIERARCHY_FILE)) return downloadEpicsAndStories();
  console.log(`\nLoading saved Jira hierarchy: ${HIERARCHY_FILE}`);
  return JSON.parse(await readFile(HIERARCHY_FILE, 'utf8')) as Hierarchy;
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
const systemPrompt = String.raw`You are a senior business analyst and relational database architect.

Analyze the complete Jira Epic and Story requirements and design a logical relational
 database ERD for the BUSINESS DOMAIN, not a diagram of Jira itself.

IMPORTANT: this must be a DATABASE TABLE ERD, not a network of entity names.
Every entity must have a useful list of columns. Include primary keys, foreign keys,
appropriate data types, and relationships with accurate cardinality.

Rules:
1. Infer only entities and columns supported by the supplied requirements.
2. Every entity must contain an "attributes" array with columns.
3. Each attribute must contain: name, type, primary_key (boolean), foreign_key (boolean).
4. Every entity should normally have one primary key. Use a natural key only when supported;
   otherwise use a sensible generated identifier such as member_id.
5. Include foreign-key columns for relationships where justified by the requirements.
6. Do not create a foreign key just because two concepts are mentioned together.
7. Avoid duplicate entities, redundant attributes, and unsupported assumptions.
8. Use simple SQL-like data types: INTEGER, BIGINT, VARCHAR(255), TEXT, DATE,
   TIMESTAMP, BOOLEAN, DECIMAL(12,2).
9. Relationship cardinality must be one-to-one, one-to-many, many-to-one, or many-to-many.
10. Use entity names that can be converted to uppercase snake-case table names.
11. If details are unclear, record a concise assumption instead of inventing business rules.
12. Keep the output compact: normally 6-12 entities, maximum 15 entities, and maximum
    8 attributes per entity. Prioritize the core business data model.
13. Keep descriptions and labels short (under 10 words).
14. Return one valid JSON object only. Do not use Markdown fences or text outside JSON.
15. Do NOT return Mermaid. The TypeScript program will generate Mermaid from your schema
    to guarantee that all tables display their columns.

Required response structure:
{
  "erd": {
    "entities": [
      {
        "name": "Member",
        "description": "A person enrolled in the scheme",
        "attributes": [
          {"name": "member_id", "type": "INTEGER", "primary_key": true, "foreign_key": false},
          {"name": "scheme_id", "type": "INTEGER", "primary_key": false, "foreign_key": true}
        ]
      }
    ],
    "relationships": [
      {"from": "Scheme", "to": "Member", "label": "has", "cardinality": "one-to-many"}
    ],
    "assumptions": []
  }
}`;
async function generateErdAndMermaid(hierarchy: Hierarchy): Promise<[Erd, string]> {
  if (!LLM_API_KEY) throw new Error('Set LLM_API_KEY in your .env file.');
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
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) throw new Error('Configure JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN in your .env file.');
  const hierarchy = await loadHierarchy();
  if (!hierarchy.epics?.length) throw new Error('No Epics found. Check the project key and Jira access.');
  console.log('\nGenerating ERD JSON and Mermaid using the LLM...');
  const [, mermaid] = await generateErdAndMermaid(hierarchy);
  console.log('\nRendering Mermaid in the cloud...');
  await renderMermaidPng(mermaid);
  console.log(`\nPipeline completed successfully.\nERD JSON: ${ERD_FILE}\nMermaid source: ${MERMAID_FILE}\nERD PNG: ${PNG_FILE}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
