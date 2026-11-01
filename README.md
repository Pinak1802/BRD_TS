# BRD_TS — AI-Assisted Requirements Engineering Pipeline

A TypeScript and Node.js proof of concept (POC) that transforms a **Business Vision** into structured requirements and design artifacts, with Jira integration.

The goal is to reduce repetitive analysis work while keeping requirements traceable from business intent through implementation planning. **AI-generated artifacts are drafts and should be reviewed before use.**

## 1. Project ambition

Turn a business idea into a connected set of engineering deliverables:

- **BRD** — Business Requirements Document
- **Jira Epics and User Stories** — actionable work items with acceptance criteria
- **ERD** — Entity Relationship Diagram and supporting structured data
- **FRD** — Functional Requirements Document
- **System Design** — architecture and design documentation, including a diagram

Each stage is organized into its own TypeScript module and uses a separate text prompt where applicable. This makes prompts easier to improve without changing application code.

## 2. End-to-end workflow

```text
Jira issue (Business_Vision.pdf attachment)
                 |
                 v
       TypeScript MCP server
                 |
                 v
      BRD generation + LLM
                 |
                 v
     BRD_GENERATION/BRD.txt
                 |
                 v
   Epic & User Story generation
                 |
                 +----> Jira (Epics + child Stories)
                 |
                 v
 BRD_TO_STORY/epics_and_stories.json
                 |
          +------+------+ 
          |             |
          v             v
     ERD generation  FRD generation
          |             |
          +------+------+ 
                 |
                 v
       System Design generation
                 |
                 v
       Design JSON / MMD / PNG
```

> **Note:** The stages are separate scripts, not necessarily one automatic command. Later stages may depend on existing outputs from earlier stages. The exact dependencies are defined in their respective source files.

## 3. Technology stack — and why

| Technology | Purpose |
|---|---|
| **TypeScript** | Typed, maintainable application code for the pipeline |
| **Node.js** | Runtime for TypeScript scripts, file operations, and API requests |
| **Model Context Protocol (MCP)** | Standardized tool interface between the BRD client and Jira-facing operations |
| **MCP TypeScript SDK** | Implements the MCP server and client using stdio transport |
| **Jira Cloud REST API** | Reads Jira issues/attachments and creates Epics and Stories |
| **LLM API** | Converts source requirements into structured documents and JSON |
| **External `.txt` prompts** | Separates instructions from implementation logic |
| **JSON** | Machine-readable intermediate artifacts for downstream stages |
| **Mermaid (`.mmd`)** | Text-based ERD and architecture diagrams |
| **Mermaid CLI** | Renders diagrams to PNG where configured |
| **pdf-parse** | Extracts Business Vision text from downloaded PDFs |
| **Git and GitHub** | Version control and collaboration |

The project has used an OpenAI-compatible LLM endpoint; model and endpoint settings should be checked in each module before running. Some stages may use a local Ollama endpoint, depending on their configuration.

## 4. Project structure

```text
BRD_TS/
├── src/
│   ├── BRD_GENERATION/
│   │   ├── brd_generation.ts
│   │   ├── brd_generation_old.ts
│   │   ├── brd_prompt.txt
│   │   └── BRD.txt
│   │
│   ├── BRD_TO_STORY/
│   │   ├── brd_to_jira_story.ts
│   │   ├── brd_to_jira_story_old.ts
│   │   ├── story_prompt.txt
│   │   └── epics_and_stories.json
│   │
│   ├── ERD/
│   │   ├── brd_to_erd.ts
│   │   ├── brd_to_erd_old.ts
│   │   └── erd_prompt.txt
│   │
│   ├── FRD/
│   │   ├── frd_generation.ts
│   │   ├── frd_generation_old.ts
│   │   └── FRD_prompt.txt
│   │
│   ├── MCP/
│   │   ├── server.ts
│   │   └── Business_Vision.pdf
│   │
│   ├── System_Design/
│   │   ├── brd_to_system_design.ts
│   │   ├── brd_to_system_design_old.ts
│   │   ├── brd_to_system_design_1.ts
│   │   └── system_design_prompt.txt
│   │
│   └── system_design_output/
│
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

The tree reflects the visible project layout. Generated output folders and files may vary by module configuration. Files ending in `_old.ts` and `_1.ts` are retained development versions, not the primary entry points.

## 5. Module-by-module explanation

### A. `MCP/` — Jira connectivity

**Main file:** `src/MCP/server.ts`

The TypeScript MCP server exposes tools for:

- Checking connectivity (`hello`)
- Reading a BRD prompt (`get_brd_prompt`, if used by a client)
- Fetching Jira issue details and attachment metadata (`get_jira_issue`)
- Downloading `Business_Vision.pdf` from a configured Jira issue (`download_business_vision`)

The server uses **stdio**, so the BRD client can start it as a child process. The PDF originates in Jira; the local copy is a downloaded working artifact.

### B. `BRD_GENERATION/` — Business Vision to BRD

**Main file:** `src/BRD_GENERATION/brd_generation.ts`

1. Connects to the TypeScript MCP server.
2. Downloads the Business Vision PDF attached to the Jira issue.
3. Extracts the PDF text.
4. Reads `brd_prompt.txt` locally.
5. Sends the prompt and extracted text to the LLM.
6. Saves the result as `BRD.txt`.

**Why:** Converts the high-level business vision into a written requirements baseline.

### C. `BRD_TO_STORY/` — BRD to Jira work items

**Main file:** `src/BRD_TO_STORY/brd_to_jira_story.ts`

- Reads `../BRD_GENERATION/BRD.txt`.
- Loads `story_prompt.txt` and requests a JSON hierarchy from the LLM.
- Validates Epic and Story fields, including acceptance criteria.
- Saves or reuses `epics_and_stories.json`.
- Creates Jira Epics, then creates each Story with its parent Epic key.

**Why:** Makes requirements actionable and groups related Stories under business-capability Epics.

**Important:** This module uses **Jira REST API calls directly** for uploads. The MCP server does not replace those calls in the current implementation. Also, rerunning the uploader can create duplicate Jira issues, even when the local JSON is reused.

### D. `ERD/` — Data modeling

**Main file:** `src/ERD/brd_to_erd.ts`

Uses requirements data and an external `erd_prompt.txt` to derive entities, attributes, and relationships. Structured ERD output can be represented as JSON and Mermaid diagram text, with a rendered PNG where configured.

**Why:** Makes the data model visible before database implementation.

### E. `FRD/` — Detailed functional requirements

**Main file:** `src/FRD/frd_generation.ts`

Uses Jira Epic/Story information and `FRD_prompt.txt` to produce a functional specification. Depending on the version/configuration, outputs may include `FRD.txt` or `FRD.json`.

**Why:** Expands user stories into more detailed functional behavior and supports requirements traceability.

### F. `System_Design/` — Architecture and technical design

**Main file:** `src/System_Design/brd_to_system_design.ts`

Uses existing requirements/design artifacts, along with `system_design_prompt.txt`, to produce a system-design representation. The pipeline can create structured JSON, Mermaid (`.mmd`), and PNG outputs.

Typical design topics include components, APIs, data flows, security, deployment, and requirement traceability. Inputs must exist at the paths expected by the script.

**Why:** Bridges business requirements and implementation architecture.

## 6. Important files and concepts

| File or concept | Meaning |
|---|---|
| `brd_prompt.txt` | Instructions for writing the BRD |
| `story_prompt.txt` | Instructions and JSON schema for Epic/Story generation |
| `erd_prompt.txt` | Instructions for data-model generation |
| `FRD_prompt.txt` | Instructions for functional requirements |
| `system_design_prompt.txt` | Instructions for system architecture/design |
| `BRD.txt` | Generated business requirements input for the Story stage |
| `epics_and_stories.json` | Structured hierarchy used for Jira uploads and downstream analysis |
| `.mmd` | Mermaid diagram source, editable as text |
| `.png` | Rendered visual diagram |
| `package.json` | Project dependencies and scripts |
| `package-lock.json` | Locks dependency versions for repeatable installation |
| `tsconfig.json` | TypeScript compilation and module settings |
| `.gitignore` | Excludes secrets, dependencies, and selected generated files from Git |

### How an external prompt is used

```typescript
const promptPath = path.join(BASE_DIR, "story_prompt.txt");
const prompt = await readFile(promptPath, "utf8");
```

`BASE_DIR` identifies the current module's directory. `path.join(...)` creates the file path, and `readFile(...)` loads the prompt text. The LLM request combines that prompt with the relevant requirements input. Editing the prompt file does not require editing a large template string inside the TypeScript source.

### Why use `epics_and_stories.json`?

JSON is easy for TypeScript to parse and validate. It also lets downstream scripts consume the same Epic/Story hierarchy without querying Jira again for every operation.

## 7. Setup

**Prerequisites:** Node.js 18+ (a current LTS release is recommended), npm, Jira Cloud access with an API token, and access to a configured LLM endpoint.

```powershell
# From the BRD_TS project root
npm.cmd install
```

Create a local `.env` file with the variables required by your modules:

```dotenv
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=your-email@example.com
JIRA_API_TOKEN=your-jira-api-token
JIRA_PROJECT_KEY=SCRUM
LLM_API_KEY=your-llm-api-key
LLM_URL=https://your-llm-endpoint/v1/chat/completions
```

Use your actual endpoint and credentials. Environment variables must be loaded by the process (for example, via `dotenv/config` or the shell). Do not commit `.env` or API tokens.

## 8. Running the pipeline

Run the scripts from the **project root**:

```powershell
# 1. Generate BRD from the Jira Business Vision attachment
npx.cmd tsx .\src\BRD_GENERATION\brd_generation.ts

# 2. Generate Epics/Stories and upload them to Jira
npx.cmd tsx .\src\BRD_TO_STORY\brd_to_jira_story.ts

# 3. Generate ERD
npx.cmd tsx .\src\ERD\brd_to_erd.ts

# 4. Generate FRD
npx.cmd tsx .\src\FRD\frd_generation.ts

# 5. Generate System Design
npx.cmd tsx .\src\System_Design\brd_to_system_design.ts
```

These are **individual entry points**. Check that each stage's expected input files exist before running it. In PowerShell, `npx.cmd` avoids execution-policy issues sometimes encountered with `npx.ps1`.

## 9. Current scope and considerations

- **Human review:** LLM outputs can be incomplete or incorrect; validate requirements and diagrams.
- **Traceability:** Preserve Jira issue keys and relationships between generated artifacts.
- **Idempotency:** Jira upload may create new issues on every run; review the JSON and Jira project before rerunning.
- **External services:** Jira and hosted LLM requests require network access and valid credentials.
- **File dependencies:** Modules use local intermediate artifacts; missing or outdated files can affect downstream results.
- **Security:** Keep tokens and sensitive business documents out of public repositories.

## 10. Future direction

Potential improvements include an orchestration command for all stages, stronger schema validation, automatic traceability checks, retry/checkpoint handling, and duplicate-safe Jira synchronization.

---

**Project type:** Proof of Concept (POC)  
**Primary language:** TypeScript  
**Domain:** AI-assisted business analysis, requirements engineering, and system design
