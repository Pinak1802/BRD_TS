import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PDFParse } from "pdf-parse";

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
// ============================================================
// 1. CONFIGURATION
// ============================================================

// TypeScript MCP server and downloaded PDF paths.
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = path.resolve(CURRENT_DIR, "../MCP/server.ts");
const PDF_PATH = path.resolve(CURRENT_DIR, "../MCP/Business_Vision.pdf");

const JIRA_ISSUE_KEY = "SCRUM-1";

// LLM configuration.

const API_KEY = process.env.LLM_API_KEY;

const LLM_URL =
    process.env.LLM_URL ??
    "https://api.apinex.bond/v1/chat/completions";

const MODEL = "free/gpt-6-luna";


// Read the BRD prompt locally, without calling the MCP server.
async function loadBrdPrompt(): Promise<string> {
    const promptPath = path.join(CURRENT_DIR, "brd_prompt.txt");
    const prompt = await readFile(promptPath, "utf-8");
    if (!prompt.trim()) {
        throw new Error("Local BRD prompt file is empty.");
    }
    return prompt;
}

// ============================================================
// 2. EXTRACT TEXT FROM MCP TOOL RESULTS
// ============================================================

function extractToolText(result: {
    isError?: boolean;
    content: Array<{
        type: string;
        text?: string;
    }>;
}): string {

    if (result.isError) {
        throw new Error(
            `MCP tool failed: ${JSON.stringify(result)}`
        );
    }

    const texts: string[] = [];

    for (const item of result.content) {

        if (item.type === "text" && typeof item.text === "string") {
            texts.push(item.text);
        }

    }

    return texts.join("\n");
}


// ============================================================
// 3. EXTRACT TEXT FROM BUSINESS VISION PDF
// ============================================================

async function extractPdfText(pdfPath: string): Promise<string> {

    // Check that the PDF exists and read its bytes.

    const pdfBuffer = await readFile(pdfPath);

    // Convert the PDF bytes into a format accepted by pdf-parse.

    const parser = new PDFParse({
        data: new Uint8Array(pdfBuffer)
    });

    try {

        // Extract text from the PDF.

        const result = await parser.getText();

        return result.text.trim();

    } finally {

        // Release PDF parser resources.

        await parser.destroy();

    }
}


// ============================================================
// 4. CALL LLM TO GENERATE THE BRD
// ============================================================

async function generateBrd(
    prompt: string,
    businessVision: string
): Promise<string> {

    if (!API_KEY) {
        throw new Error(
            "Set the LLM_API_KEY environment variable first."
        );
    }

    // Combine the BRD prompt and Business Vision text.

    const userMessage =
        prompt +
        "\n\nBusiness Vision:\n" +
        businessVision;


    // Create the OpenAI-compatible request payload.

    const payload = {

        model: MODEL,

        messages: [
            {
                role: "user",
                content: userMessage
            }
        ]

    };


    // Send the request to the LLM API.

    const response = await fetch(LLM_URL, {

        method: "POST",

        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${API_KEY}`,
            "User-Agent": "BRD-TypeScript-Client/1.0"
        },

        body: JSON.stringify(payload),

        signal: AbortSignal.timeout(120_000)

    });


    // Handle HTTP errors.

    if (!response.ok) {

        const errorBody = await response.text();

        console.error("LLM HTTP status:", response.status);
        console.error("LLM response body:", errorBody);

        throw new Error(
            `LLM API failed: HTTP ${response.status}\n${errorBody}`
        );

    }


    console.log(`\nLLM HTTP STATUS: ${response.status}`);


    // Parse the OpenAI-compatible response.

    const root = await response.json() as {
        choices?: Array<{
            message?: {
                content?: unknown;
            };
        }>;
    };


    const brd = root.choices?.[0]?.message?.content;


    // Validate the generated BRD.

    if (typeof brd !== "string" || !brd.trim()) {

        throw new Error(
            "LLM returned an empty BRD or an unexpected response format."
        );

    }


    return brd;

}


// ============================================================
// 5. MAIN WORKFLOW: MCP -> PDF -> PROMPT -> LLM -> BRD
// ============================================================

async function main(): Promise<void> {

    console.log("Starting TypeScript MCP client...");


    // --------------------------------------------------------
    // Prepare the environment for the TypeScript MCP server.
    // --------------------------------------------------------

    const childEnv: Record<string, string> = {};

    for (const [key, value] of Object.entries(process.env)) {

        if (value !== undefined) {
            childEnv[key] = value;
        }

    }


    // Validate the Jira environment variables.

    const jiraVariables = [
        "JIRA_BASE_URL",
        "JIRA_EMAIL",
        "JIRA_API_TOKEN"
    ];

    for (const variable of jiraVariables) {

        if (!childEnv[variable]) {

            throw new Error(
                `Missing required environment variable: ${variable}`
            );

        }

    }


    // --------------------------------------------------------
    // Configure the MCP stdio transport.
    // --------------------------------------------------------

    const transport = new StdioClientTransport({

        command: "npx.cmd",

        args: ["--no-install", "tsx", MCP_SERVER],

        env: childEnv

    });


    // Create the MCP client.

    const client = new Client({

        name: "brd-typescript-client",

        version: "1.0.0"

    });


    try {

        // Connect to the TypeScript MCP server.

        await client.connect(transport);

        console.log("Connected to TypeScript MCP server!");


        // ----------------------------------------------------
        // STEP 1: DOWNLOAD BUSINESS VISION FROM JIRA
        // ----------------------------------------------------

        console.log("\nDownloading Business Vision from Jira...");


        const visionResult = await client.callTool({

            name: "download_business_vision",

            arguments: {
                issue_key: JIRA_ISSUE_KEY
            }

        });


        const visionToolText = extractToolText(visionResult);


        console.log("Business Vision tool response:");

        console.log(visionToolText);


        if (
            visionToolText.includes("Failed") ||
            visionToolText.toLowerCase().includes("not found")
        ) {

            throw new Error(
                "Could not download Business Vision from Jira."
            );

        }


        // ----------------------------------------------------
        // STEP 2: READ THE LOCAL BRD PROMPT
        // ----------------------------------------------------

        console.log("\nRetrieving BRD prompt...");

        const brdPrompt = await loadBrdPrompt();

        console.log("BRD prompt retrieved successfully.");


        // ----------------------------------------------------
        // STEP 3: EXTRACT TEXT FROM THE BUSINESS VISION PDF
        // ----------------------------------------------------

        console.log("\nExtracting Business Vision PDF text...");


        const businessVision = await extractPdfText(PDF_PATH);


        if (!businessVision) {

            throw new Error(
                "Business Vision PDF contains no readable text."
            );

        }


        console.log("\nBusiness Vision text:");

        console.log(businessVision);


        // ----------------------------------------------------
        // STEP 4: SEND PROMPT + BUSINESS VISION TO THE LLM
        // ----------------------------------------------------

        console.log(
            "\nGenerating Business Requirements Document..."
        );


        const brd = await generateBrd(
            brdPrompt,
            businessVision
        );


        // ----------------------------------------------------
        // STEP 5: DISPLAY AND SAVE THE BRD
        // ----------------------------------------------------

        console.log("\n" + "=".repeat(60));

        console.log("GENERATED BUSINESS REQUIREMENTS DOCUMENT");

        console.log("=".repeat(60));

        console.log(brd);


        // Save BRD.txt beside client.ts, as in the Python version.

        const currentDirectory = path.dirname(
            fileURLToPath(import.meta.url)
        );


        const outputPath = path.join(
            currentDirectory,
            "BRD.txt"
        );


        await writeFile(
            outputPath,
            brd,
            "utf-8"
        );


        console.log(`\nBRD saved to: ${outputPath}`);

        console.log("BRD generation completed successfully.");

    } finally {

        // Close the MCP connection and its child process.

        await client.close();

    }

}


// ============================================================
// APPLICATION ENTRY POINT
// ============================================================

main().catch((error: unknown) => {

    console.error("\nBRD generation failed:");

    if (error instanceof Error) {

        console.error(error.message);

    } else {

        console.error(error);

    }

    process.exitCode = 1;

});