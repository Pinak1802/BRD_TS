import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const FRD_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.dirname(FRD_DIR);
const ROOT_DIR = path.dirname(SRC_DIR);
const JIRA_PATH = path.join(SRC_DIR, 'epics_and_stories.json');
const PROMPT_PATH = path.join(FRD_DIR, 'FRD_prompt.txt');
const OUTPUT_DIR = path.join(ROOT_DIR, 'frd_output');
const PARTS_DIR = path.join(OUTPUT_DIR, 'parts');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'FRD.txt');
const LLM_URL = process.env.LLM_URL || 'https://api.apinex.bond/v1/chat/completions';
const MODEL = process.env.LLM_MODEL || 'free/gpt-6-luna';
const API_KEY = process.env.LLM_API_KEY;
const BATCH_SIZE = Math.max(1, Math.min(10, Number(process.env.FRD_BATCH_SIZE || 3)));
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 120_000;
const REQUEST_TIMEOUT_MS = 115_000;

type Obj = Record<string, unknown>;
type Story = { key: string; summary: string; description: unknown; acceptanceCriteria: unknown; businessRules: unknown; priority: unknown; epicKey: string; epicSummary: string };
type Epic = { key: string; summary: string; description: unknown };
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const array = (x: unknown): unknown[] => Array.isArray(x) ? x : [];
const value = (x: unknown): string => typeof x === 'string' ? x : x == null ? '' : JSON.stringify(x);
function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}
function parseJira(raw: unknown): { epics: Epic[]; stories: Story[] } {
  const root: Obj = isObj(raw) ? raw : {};
  const epicRaw = Array.isArray(raw) ? raw : array(pick(root, 'epics', 'data', 'items'));
  const epics: Epic[] = [];
  const stories: Story[] = [];
  const seen = new Set<string>();
function addStory(s: Obj, epicKey: string, epicSummary: string) {
  const key = value(pick(s, 'key', 'issueKey', 'issue_key')).trim();

  const storyReference =
    key || `SRC-${String(stories.length + 1).padStart(3, '0')}`;

  stories.push({
    key: storyReference,
    epicKey,
    epicSummary,
    summary: value(pick(s, 'summary', 'title', 'name')),
    description: pick(s, 'description', 'details') ?? '',
    acceptanceCriteria:
      pick(s, 'acceptanceCriteria', 'acceptance_criteria') ?? [],
    businessRules:
      pick(s, 'businessRules', 'business_rules') ?? [],
    priority: pick(s, 'priority') ?? ''
  });
}
  for (const item of epicRaw) {
    if (!isObj(item)) continue;
    const epicKey = value(pick(item, 'key', 'epic_key', 'id'));
    const epicSummary = value(pick(item, 'summary', 'epic_summary', 'name', 'title'));
    epics.push({ key: epicKey, summary: epicSummary, description: pick(item, 'description', 'details') ?? '' });
    for (const s of array(pick(item, 'stories', 'issues', 'children'))) if (isObj(s)) addStory(s, epicKey, epicSummary);
  }
  for (const s of array(pick(root, 'stories', 'issues'))) if (isObj(s)) addStory(s, '', '');
  if (!stories.length) throw new Error('Jira JSON contains no usable stories.');
  return { epics, stories };
}
function sleep(ms: number) { return new Promise<void>(resolve => setTimeout(resolve, ms)); }
function hash(text: string) { return createHash('sha256').update(text).digest('hex').slice(0, 20); }
async function requestLLM(prompt: string, data: unknown, batchNo: number, count: number): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      console.log(`Batch ${batchNo}/${count}: API attempt ${attempt + 1}`);
      const response = await fetch(LLM_URL, {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({ model: MODEL, temperature: 0.1, max_tokens: 3500,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: `Generate the FRD section for batch ${batchNo} of ${count}. Use the following source Jira records only.\n\n${JSON.stringify(data, null, 2)}` },
          ],
        }),
      });
      const raw = await response.text();
      if (!response.ok) {
        const error = new Error(`LLM HTTP ${response.status}: ${raw.slice(0, 450)}`);
        if ([429, 500, 502, 503, 504, 524].includes(response.status) && attempt < MAX_RETRIES) {
          console.warn(error.message);
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw error;
      }
      const parsed: unknown = JSON.parse(raw);
      const obj = isObj(parsed) ? parsed : {};
      const choice = array(obj.choices)[0];
      const choiceObj = isObj(choice) ? choice : {};
      const message = isObj(choiceObj.message) ? choiceObj.message : {};
      const content = typeof message.content === 'string' ? message.content.trim() : '';
      if (!content) throw new Error(`Empty LLM response for batch ${batchNo}`);
      if (choiceObj.finish_reason === 'length') throw new Error(`Batch ${batchNo} was truncated. Reduce FRD_BATCH_SIZE or increase output allowance.`);
      return content;
    } catch (err) {
      if (attempt < MAX_RETRIES && (err instanceof TypeError || (err instanceof Error && err.name === 'AbortError'))) {
        console.warn(`Batch ${batchNo} connection/timeout issue: ${String(err)}. Retrying in 120 seconds.`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw err;
    } finally { clearTimeout(timer); }
  }
  throw new Error(`Batch ${batchNo} exhausted retries.`);
}
async function main() {
  console.log('=== BATCH FRD GENERATOR (APINEX) ===');
  if (!existsSync(JIRA_PATH)) throw new Error(`Missing Jira JSON: ${JIRA_PATH}. No Jira download attempted.`);
  if (!existsSync(PROMPT_PATH)) throw new Error(`Missing FRD prompt: ${PROMPT_PATH}`);
  if (!API_KEY?.trim()) throw new Error('LLM_API_KEY missing from BRD_TS/.env');
  if (!Number.isInteger(BATCH_SIZE)) throw new Error('FRD_BATCH_SIZE must be an integer.');
  const [jsonText, prompt] = await Promise.all([readFile(JIRA_PATH, 'utf8'), readFile(PROMPT_PATH, 'utf8')]);
  if (!prompt.trim()) throw new Error('FRD prompt is empty.');
  const { epics, stories } = parseJira(JSON.parse(jsonText));
  const batches: Story[][] = [];
  for (let i = 0; i < stories.length; i += BATCH_SIZE) batches.push(stories.slice(i, i + BATCH_SIZE));
  await mkdir(PARTS_DIR, { recursive: true });
  console.log(`Jira: ${JIRA_PATH}\nEpics: ${epics.length}; Stories: ${stories.length}; Batches: ${batches.length}\nModel: ${MODEL}`);
  const sections: string[] = [];
  const issues: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const epicKeys = new Set(batch.map(s => s.epicKey));
    const relatedEpics = epics.filter(e => epicKeys.has(e.key));
    const input = { epics: relatedEpics, stories: batch };
    const fingerprint = hash(JSON.stringify({ prompt, input, model: MODEL }));
    const partFile = path.join(PARTS_DIR, `batch_${String(i + 1).padStart(2, '0')}_${fingerprint}.txt`);
    let content: string;
    if (existsSync(partFile)) {
      console.log(`Batch ${i + 1}/${batches.length}: using saved result`);
      content = await readFile(partFile, 'utf8');
    } else {
      content = await requestLLM(prompt, input, i + 1, batches.length);
      await writeFile(partFile, `${content.trim()}\n`, 'utf8');
      console.log(`Saved batch: ${partFile}`);
    }
    const missing = batch.filter(s => !content.includes(s.key)).map(s => s.key);
    if (missing.length) issues.push(`Batch ${i + 1}: missing Jira references in generated text: ${missing.join(', ')}`);
    sections.push(`PART ${i + 1} OF ${batches.length} | JIRA STORIES: ${batch.map(s => s.key).join(', ')}\n${'='.repeat(75)}\n${content.trim()}`);
  }
  const trace = stories.map(s => `${s.key} | Epic: ${s.epicKey || 'Not specified'} | ${s.summary}`).join('\n');
  const gaps = epics.filter(e => !stories.some(s => s.epicKey === e.key));
  const report = [
    'FUNCTIONAL REQUIREMENTS DOCUMENT (FRD)',
    'Compiled from Jira Epics and Stories using batched LLM generation.',
    `Source: src/epics_and_stories.json`,
    `Epics: ${epics.length} | Unique stories: ${stories.length} | Generated sections: ${batches.length}`,
    'Requirement IDs in generated sections are batch-local; use Jira keys for cross-section traceability.',
    '', 'SOURCE STORY INVENTORY', trace,
    '', 'EPICS WITHOUT ASSOCIATED STORIES', gaps.length ? gaps.map(e => `${e.key} | ${e.summary}`).join('\n') : 'None',
    '', 'FRD FUNCTIONAL SECTIONS', sections.join('\n\n' + '='.repeat(75) + '\n\n'),
    '', 'AUTOMATED COVERAGE CHECK', issues.length ? issues.join('\n') : 'Every source story key was found in its generated batch text.',
    'NOTE: Key presence is a basic check, not proof that every acceptance criterion was captured. Review each section against Jira.',
  ].join('\n');
  await writeFile(OUTPUT_PATH, `${report}\n`, 'utf8');
  console.log(`FRD saved: ${OUTPUT_PATH}`);
  if (issues.length) console.warn('Coverage warnings:\n' + issues.join('\n'));
}
main().catch(err => { console.error('FRD generation failed:', err); process.exitCode = 1; });
