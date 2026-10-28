import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url));
const BRD_PATH = path.join(BASE_DIR, "BRD.txt");
const OUTPUT_JSON_PATH = path.join(BASE_DIR, "epics_and_stories.json");

const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_URL = process.env.LLM_URL ?? "https://api.apinex.bond/v1/chat/completions";
const LLM_MODEL = "free/gpt-6-luna";
const JIRA_BASE_URL = (process.env.JIRA_BASE_URL ?? "").replace(/\/+$/, "");
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY ?? "SCRUM";
const EPIC_NAME_FIELD = process.env.JIRA_EPIC_NAME_FIELD ?? "customfield_10011"; // Kept for parity; not used by the original create request.

interface Story {
  summary: string;
  description: string;
  acceptanceCriteria: string[];
}
interface Epic {
  summary: string;
  description: string;
  stories: Story[];
}
interface GeneratedData {
  epics: Epic[];
}
interface JiraCreateResponse { key?: string; id?: string; self?: string }
interface CreatedItem {
  type: "Epic" | "Story";
  key: string;
  summary: string;
  url: string;
  parentEpic?: string;
}
interface ADFNode { type: "paragraph"; content: { type: "text"; text: string }[] }
interface ADFDocument { type: "doc"; version: 1; content: ADFNode[] }

function requireConfig(): void {
  if (!LLM_API_KEY) throw new Error("Set LLM_API_KEY first.");
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error("Set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.");
  }
}

async function readBrd(): Promise<string> {
  if (!existsSync(BRD_PATH)) throw new Error(`BRD file not found: ${BRD_PATH}`);
  const brd = (await readFile(BRD_PATH, "utf8")).trim();
  if (!brd) throw new Error("BRD.txt is empty.");
  return brd;
}

const PROMPT = `You are a Senior Business Analyst and Agile Product Owner.

Analyze the supplied Business Requirements Document (BRD).
Break it into a sensible Jira Epic and User Story hierarchy.

BUSINESS ANALYSIS RULES:
1. Create multiple meaningful Epics based on distinct business
   capabilities, not one Epic for the entire project.
2. Place multiple related User Stories under each Epic.
3. Every Story must belong to exactly one Epic.
4. Derive requirements only from the BRD. Do not invent
   unrelated functionality or unsupported business rules.
5. Avoid duplicate, overlapping or excessively granular stories.
6. Write every Story in this format:
   As a [user role], I want [capability], so that [benefit].
7. Give each Story 2 to 5 clear, testable acceptance criteria.
8. Use concise, business-oriented Epic descriptions.
9. Make Epic and Story summaries suitable for Jira.
10. Include enough stories to cover the BRD meaningfully.
    Do not force an arbitrary number of Epics or stories.

Return ONLY valid JSON. Do not use Markdown fences,
comments, explanations or text outside the JSON.

Required JSON structure:
{
  "epics": [
    {
      "summary": "Epic title",
      "description": "Epic business objective and scope",
      "stories": [
        {
          "summary": "User story title",
          "description": "As a ... I want ... so that ...",
          "acceptanceCriteria": [
            "Given ... when ... then ...",
            "Another testable criterion"
          ]
        }
      ]
    }
  ]
}

Every Epic must contain at least one Story.
The top-level property must be named "epics".`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateGeneratedData(data: unknown): asserts data is GeneratedData {
  if (!isRecord(data)) throw new Error("The generated result must be a JSON object.");
  const epics = data.epics;
  if (!Array.isArray(epics) || epics.length === 0) throw new Error("No Epics were generated.");

  epics.forEach((epic: unknown, epicIndex: number) => {
    if (!isRecord(epic)) throw new Error(`Epic ${epicIndex + 1} is invalid.`);
    if (typeof epic.summary !== "string") throw new Error(`Epic ${epicIndex + 1} has no valid summary.`);
    epic.summary = epic.summary.trim();
    if (!epic.summary) throw new Error(`Epic ${epicIndex + 1} has an empty summary.`);
    if (typeof epic.description !== "string") throw new Error(`Epic ${epicIndex + 1} has no valid description.`);
    const stories = epic.stories;
    if (!Array.isArray(stories) || stories.length === 0) {
      throw new Error(`Epic ${epicIndex + 1} must contain at least one Story.`);
    }
    stories.forEach((story: unknown, storyIndex: number) => {
      if (!isRecord(story)) throw new Error(`Story ${storyIndex + 1} in Epic ${epicIndex + 1} is invalid.`);
      for (const field of ["summary", "description"] as const) {
        if (typeof story[field] !== "string") {
          throw new Error(`Story ${storyIndex + 1} in Epic ${epicIndex + 1} has no valid ${field}.`);
        }
        story[field] = story[field].trim();
        if (!story[field]) throw new Error(`Story ${storyIndex + 1} has an empty ${field}.`);
      }
      const criteria = story.acceptanceCriteria;
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 5 ||
          criteria.some((item: unknown) => typeof item !== "string" || !item.trim())) {
        throw new Error(`Story ${storyIndex + 1} in Epic ${epicIndex + 1} must have 2-5 non-empty acceptance criteria.`);
      }
    });
  });
  const storyCount = epics.reduce((sum: number, epic: Epic) => sum + epic.stories.length, 0);
  console.log(`Validated ${epics.length} Epics and ${storyCount} User Stories.`);
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function generateEpicsAndStories(brd: string): Promise<GeneratedData> {
  const payload = {
    model: LLM_MODEL,
    messages: [
      { role: "system", content: "You are a precise business analyst. Return valid JSON only." },
      { role: "user", content: `${PROMPT}\n\nBUSINESS REQUIREMENTS DOCUMENT:\n${brd}` },
    ],
    temperature: 0.2,
  };
  const response = await fetchWithTimeout(LLM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
      "User-Agent": "BRD-Epic-Story-Generator/1.0",
    },
    body: JSON.stringify(payload),
  }, 180_000);
  const responseText = await response.text();
  if (!response.ok) throw new Error(`LLM API error ${response.status}: ${responseText}`);
  const root: unknown = JSON.parse(responseText);
  const content = (root as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("LLM returned empty JSON content.");
  const cleanContent = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let result: unknown;
  try {
    result = JSON.parse(cleanContent);
  } catch {
    throw new Error(`LLM did not return valid JSON. Response begins: ${cleanContent.slice(0, 1000)}`);
  }
  validateGeneratedData(result);
  return result;
}

async function jiraRequest<T = Record<string, unknown>>(
  method: "GET" | "POST", endpoint: string, payload?: unknown,
): Promise<T> {
  const credentials = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`, "utf8").toString("base64");
  const response = await fetchWithTimeout(`${JIRA_BASE_URL}${endpoint}`, {
    method,
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }, 60_000);
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Jira API failed: ${method} ${endpoint}; HTTP ${response.status}; response: ${responseBody}`);
  }
  return responseBody.trim() ? JSON.parse(responseBody) as T : {} as T;
}

function toAdf(text: string): ADFDocument {
  const paragraphs: ADFNode[] = text.split(/\r?\n/).map(line => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : [],
  }));
  return { type: "doc", version: 1, content: paragraphs };
}

function buildStoryDescription(story: Story): string {
  const criteriaText = story.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n");
  return `${story.description}\n\nAcceptance Criteria:\n${criteriaText}`;
}

async function createEpic(epic: Epic): Promise<string> {
  const fields = {
    project: { key: JIRA_PROJECT_KEY },
    issuetype: { id: "10001" }, // Matches original Python code; confirm for your Jira project.
    summary: epic.summary,
    description: toAdf(epic.description),
  };
  const response = await jiraRequest<JiraCreateResponse>("POST", "/rest/api/3/issue", { fields });
  if (!response.key) throw new Error(`Jira did not return an Epic key: ${JSON.stringify(response)}`);
  return response.key;
}

async function createStory(story: Story, epicKey: string): Promise<string> {
  const fields = {
    project: { key: JIRA_PROJECT_KEY },
    issuetype: { name: "Story" },
    summary: story.summary,
    description: toAdf(buildStoryDescription(story)),
    parent: { key: epicKey },
  };
  const response = await jiraRequest<JiraCreateResponse>("POST", "/rest/api/3/issue", { fields });
  if (!response.key) throw new Error(`Jira did not return a Story key: ${JSON.stringify(response)}`);
  console.log(`  Created Story: ${response.key} - ${story.summary} (parent Epic: ${epicKey})`);
  return response.key;
}

async function uploadToJira(data: GeneratedData): Promise<CreatedItem[]> {
  const createdItems: CreatedItem[] = [];
  for (const [epicIndex, epic] of data.epics.entries()) {
    console.log(`\nCreating Epic ${epicIndex + 1}: ${epic.summary}`);
    const epicKey = await createEpic(epic);
    createdItems.push({ type: "Epic", key: epicKey, summary: epic.summary, url: `${JIRA_BASE_URL}/browse/${epicKey}` });
    for (const story of epic.stories) {
      const storyKey = await createStory(story, epicKey);
      createdItems.push({ type: "Story", key: storyKey, summary: story.summary, parentEpic: epicKey, url: `${JIRA_BASE_URL}/browse/${storyKey}` });
    }
  }
  return createdItems;
}

// Equivalent to Python's optional find_epic_name_field() helper.
// The original main() does not call it.
async function findEpicNameField(): Promise<void> {
  console.log("Checking Epic creation metadata...");
  const metadata = await jiraRequest<{ issueTypes?: { id: string; name: string; subtask?: boolean }[] }>(
    "GET", `/rest/api/3/issue/createmeta/${encodeURIComponent(JIRA_PROJECT_KEY)}/issuetypes`,
  );
  console.log("\nAvailable issue types:");
  for (const issueType of metadata.issueTypes ?? []) {
    console.log(`Name: ${issueType.name} | ID: ${issueType.id} | Subtask: ${issueType.subtask}`);
    if (issueType.name.toLowerCase() === "epic") {
      console.log("\nFetching fields available for Epic...");
      const details = await jiraRequest<{ fields?: { name: string; fieldId: string; required?: boolean; operations?: string[] }[] }>(
        "GET", `/rest/api/3/issue/createmeta/${encodeURIComponent(JIRA_PROJECT_KEY)}/issuetypes/${issueType.id}`,
      );
      for (const field of details.fields ?? []) {
        console.log(`Name: ${field.name} | ID: ${field.fieldId} | Required: ${field.required} | Operations: ${field.operations}`);
      }
    }
  }
}

async function main(): Promise<void> {
  requireConfig();
  const brd = await readBrd();
  let generatedData: GeneratedData;
  if (existsSync(OUTPUT_JSON_PATH)) {
    console.log("Using existing generated hierarchy...");
    generatedData = JSON.parse(await readFile(OUTPUT_JSON_PATH, "utf8")) as GeneratedData;
  } else {
    console.log("Generating Epics and User Stories using the LLM...");
    generatedData = await generateEpicsAndStories(brd);
    await writeFile(OUTPUT_JSON_PATH, JSON.stringify(generatedData, null, 2), "utf8");
  }
  // Preserve Python's behavior: upload after saving/reusing the hierarchy.
  await writeFile(OUTPUT_JSON_PATH, JSON.stringify(generatedData, null, 2), "utf8");
  console.log(`Generated hierarchy saved to: ${OUTPUT_JSON_PATH}`);
  console.log("\nUploading Epics and Stories to Jira...");
  const createdItems = await uploadToJira(generatedData);
  console.log("\n" + "=".repeat(60));
  console.log("JIRA UPLOAD SUMMARY");
  console.log("=".repeat(60));
  for (const item of createdItems) {
    console.log(`${item.type}: ${item.key} | ${item.summary}\nURL: ${item.url}`);
  }
  console.log(`\nTotal issues created: ${createdItems.length}`);
  console.log("Upload process completed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
