
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// =========================================================
// CONFIGURATION
// =========================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const mcp = new McpServer({
  name: "Jira BRD Agent",
  version: "1.0.0",
});

const JIRA_BASE_URL = process.env.JIRA_BASE_URL?.replace(/\/+$/, "");
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// =========================================================
// HELPER: RETURN MCP TEXT RESPONSE
// =========================================================

function textResponse(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

// =========================================================
// HELPER: JIRA AUTHENTICATION
// =========================================================

function getJiraHeaders(): Record<string, string> {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error(
      "Missing Jira environment variables: " +
      "JIRA_BASE_URL, JIRA_EMAIL or JIRA_API_TOKEN"
    );
  }

  const auth = Buffer.from(
    `${JIRA_EMAIL}:${JIRA_API_TOKEN}`
  ).toString("base64");

  return {
    Authorization: `Basic ${auth}`,
    Accept: "application/json",
  };
}

// =========================================================
// HELPER: FETCH JIRA ISSUE
// =========================================================

async function fetchJiraIssue(issueKey: string): Promise<any> {
  const headers = getJiraHeaders();

  const url =
    `${JIRA_BASE_URL}/rest/api/3/issue/` +
    encodeURIComponent(issueKey);

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Jira request failed\n` +
      `HTTP Status: ${response.status}\n` +
      `URL: ${url}\n` +
      `Response: ${errorText}`
    );
  }

  return response.json();
}

// =========================================================
// 1. GET BRD PROMPT
// =========================================================

mcp.registerTool(
  "get_brd_prompt",
  {
    description: "Read the BRD generation prompt from brd_prompt.txt",
  },
  async () => {
    try {
      const promptPath = path.join(
        __dirname,
        "brd_prompt.txt"
      );

      const prompt = fs.readFileSync(
        promptPath,
        "utf-8"
      );

      return textResponse(prompt);

    } catch (error) {
      return textResponse(
        `Failed to read BRD prompt: ${String(error)}`
      );
    }
  }
);

// =========================================================
// 2. HELLO TEST
// =========================================================

mcp.registerTool(
  "hello",
  {
    description: "Say hello to a user",
    inputSchema: {
      name: z.string(),
    },
  },
  async ({ name }) => {
    return textResponse(
      `Hello ${name}, FastMCP is working!`
    );
  }
);

// =========================================================
// 3. GET JIRA ISSUE
// =========================================================

mcp.registerTool(
  "get_jira_issue",
  {
    description: "Fetch a Jira issue and its attachments",
    inputSchema: {
      issue_key: z.string(),
    },
  },
  async ({ issue_key }) => {
    try {
      const data = await fetchJiraIssue(issue_key);

      const fields = data.fields ?? {};
      const summary = fields.summary ?? "";
      const attachments = fields.attachment ?? [];

      const result: string[] = [
        `Issue: ${issue_key}`,
        `Summary: ${summary}`,
        "",
        "Attachments:",
      ];

      if (attachments.length === 0) {
        result.push("No attachments found.");
      } else {
        for (const attachment of attachments) {
          result.push(
            `- ${attachment.filename ?? ""}`
          );

          result.push(
            `  ID: ${attachment.id ?? ""}`
          );

          result.push(
            `  Size: ${attachment.size ?? 0} bytes`
          );

          result.push(
            `  Content URL: ${attachment.content ?? ""}`
          );
        }
      }

      return textResponse(result.join("\n"));

    } catch (error) {
      return textResponse(String(error));
    }
  }
);

// =========================================================
// 4. DOWNLOAD BUSINESS VISION
// =========================================================

mcp.registerTool(
  "download_business_vision",
  {
    description:
      "Download Business_Vision.pdf attachment from a Jira issue",
    inputSchema: {
      issue_key: z.string(),
    },
  },
  async ({ issue_key }) => {
    try {
      // ---------------------------------------------------
      // Check environment variables
      // ---------------------------------------------------

      console.error(
        "JIRA_BASE_URL available:",
        Boolean(JIRA_BASE_URL)
      );

      console.error(
        "JIRA_EMAIL available:",
        Boolean(JIRA_EMAIL)
      );

      console.error(
        "JIRA_API_TOKEN available:",
        Boolean(JIRA_API_TOKEN)
      );

      // ---------------------------------------------------
      // Get Jira issue
      // ---------------------------------------------------

      const issueData = await fetchJiraIssue(issue_key);

      const attachments =
        issueData.fields?.attachment ?? [];

      // ---------------------------------------------------
      // Find Business_Vision.pdf
      // ---------------------------------------------------

      const businessVision = attachments.find(
        (attachment: any) =>
          attachment.filename === "Business_Vision.pdf"
      );

      if (!businessVision) {
        return textResponse(
          "Business_Vision.pdf was not found."
        );
      }

      // ---------------------------------------------------
      // Download attachment
      // ---------------------------------------------------

      const downloadUrl = businessVision.content;

      if (!downloadUrl) {
        return textResponse(
          "Attachment content URL is missing."
        );
      }

      const pdfResponse = await fetch(
        downloadUrl,
        {
          headers: getJiraHeaders(),
          redirect: "follow",
        }
      );

      if (!pdfResponse.ok) {
        const errorText = await pdfResponse.text();

        return textResponse(
          `Failed to download PDF\n` +
          `HTTP Status: ${pdfResponse.status}\n` +
          `URL: ${downloadUrl}\n` +
          `Response: ${errorText}`
        );
      }

      // ---------------------------------------------------
      // Save PDF
      // ---------------------------------------------------

      const pdfBuffer = Buffer.from(
        await pdfResponse.arrayBuffer()
      );

      const outputPath = path.join(
        __dirname,
        "Business_Vision.pdf"
      );

      fs.writeFileSync(outputPath, pdfBuffer);

      return textResponse(
        `Business_Vision.pdf downloaded successfully.\n` +
        `Path: ${outputPath}\n` +
        `Size: ${pdfBuffer.length} bytes`
      );

    } catch (error) {
      return textResponse(
        `Failed to download Business Vision: ${String(error)}`
      );
    }
  }
);

// =========================================================
// START MCP SERVER
// =========================================================

async function main(): Promise<void> {
  const transport = new StdioServerTransport();

  await mcp.connect(transport);

  console.error("Jira BRD MCP Server is running...");
}

main().catch((error) => {
  console.error("MCP Server Error:", error);
  process.exit(1);
});
