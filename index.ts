#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { SequentialThinkingServer } from './lib.js';
import { SERVER_VERSION } from './version.js';

/** Safe boolean coercion that correctly handles string "false". A union+transform,
 * not z.preprocess (whose input type is `unknown`), so JSON Schema keeps this required. */
const coercedBoolean = z.union([z.boolean(), z.string()]).transform((val, ctx) => {
  if (typeof val === "boolean") return val;
  if (val.toLowerCase() === "true") return true;
  if (val.toLowerCase() === "false") return false;
  ctx.addIssue({ code: "custom", message: `Expected boolean or "true"/"false" string, received "${val}"` });
  return z.NEVER;
});

const thinkingToolDescription = `A detailed tool for dynamic and reflective problem-solving through thoughts.
This tool helps analyze problems through a flexible thinking process that can adapt and evolve.
Each thought can build on, question, or revise previous insights as understanding deepens.

When to use this tool:
- Breaking down complex problems into steps
- Planning and design with room for revision
- Analysis that might need course correction
- Problems where the full scope might not be clear initially
- Problems that require a multi-step solution
- Tasks that need to maintain context over multiple steps
- Situations where irrelevant information needs to be filtered out

Key features:
- You can adjust total_thoughts up or down as you progress
- You can question or revise previous thoughts
- You can add more thoughts even after reaching what seemed like the end
- You can express uncertainty and explore alternative approaches
- Not every thought needs to build linearly - you can branch or backtrack
- Generates a solution hypothesis
- Verifies the hypothesis based on the Chain of Thought steps
- Repeats the process until satisfied
- Provides a correct answer

Parameters explained:
- thought: Your current thinking step, which can include:
  * Regular analytical steps
  * Revisions of previous thoughts
  * Questions about previous decisions
  * Realizations about needing more analysis
  * Changes in approach
  * Hypothesis generation
  * Hypothesis verification
- nextThoughtNeeded: True if you need more thinking, even if at what seemed like the end
- thoughtNumber: Current number in sequence (can go beyond initial total if needed)
- totalThoughts: Current estimate of thoughts needed (can be adjusted up/down)
- isRevision: A boolean indicating if this thought revises previous thinking
- revisesThought: If is_revision is true, which thought number is being reconsidered
- branchFromThought: If branching, which thought number is the branching point
- branchId: Identifier for the current branch (if any)
- needsMoreThoughts: If reaching end but realizing more thoughts needed

You should:
1. Start with an initial estimate of needed thoughts, but be ready to adjust
2. Feel free to question or revise previous thoughts
3. Don't hesitate to add more thoughts if needed, even at the "end"
4. Express uncertainty when present
5. Mark thoughts that revise previous thinking or branch into new paths
6. Ignore information that is irrelevant to the current step
7. Generate a solution hypothesis when appropriate
8. Verify the hypothesis based on the Chain of Thought steps
9. Repeat the process until satisfied with the solution
10. Provide a single, ideally correct answer as the final output
11. Only set nextThoughtNeeded to false when truly done and a satisfactory answer is reached`;

const thinkingToolSchema = {
  thought: z.string().describe("Your current thinking step"),
  nextThoughtNeeded: coercedBoolean.describe("Whether another thought step is needed"),
  thoughtNumber: z.coerce.number().int().min(1).describe("Current thought number (numeric value, e.g., 1, 2, 3)"),
  totalThoughts: z.coerce.number().int().min(1).describe("Estimated total thoughts needed (numeric value, e.g., 5, 10)"),
  isRevision: coercedBoolean.optional().describe("Whether this revises previous thinking"),
  revisesThought: z.coerce.number().int().min(1).optional().describe("Which thought is being reconsidered"),
  branchFromThought: z.coerce.number().int().min(1).optional().describe("Branching point thought number"),
  branchId: z.string().optional().describe("Branch identifier"),
  needsMoreThoughts: coercedBoolean.optional().describe("If more thoughts are needed")
};

function createAndGetServer() {
  const server = new McpServer({
    name: "sequential-thinking-server",
    version: SERVER_VERSION,
  });
  const thinkingServer = new SequentialThinkingServer();

  server.tool("sequentialthinking", thinkingToolDescription, thinkingToolSchema, async (args) => {
    const result = thinkingServer.processThought(args);

    if (result.isError) {
      return result;
    }

    // Parse the JSON response to get structured content
    const parsedContent = JSON.parse(result.content[0].text);

    return {
      content: result.content,
      structuredContent: parsedContent
    };
  });

  return server;
}

// 定义一个服务器
const app = express();
app.use(express.json());

// Store transports for each session type
const transports = {
  sse: {} as Record<string, SSEServerTransport>
};

// HTTP SSE模式需要的请求地址
app.get('/sse', (req, res, next) => {
  // Create SSE transport for legacy clients
  console.log("http /sse request start.......");
  const transport = new SSEServerTransport('/messages', res);
  transports.sse[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports.sse[transport.sessionId];
  });

  const server = createAndGetServer();
  server.connect(transport).then(() => {
    console.log("http sse request connect");
  }).catch(next);
});


// HTTP SSE模式需要的请求地址messages
app.post('/messages', (req, res, next) => {
  console.log("http /sse request receive message");
  const sessionId = req.query.sessionId;
  if (typeof sessionId !== "string") {
    res.status(400).send('Missing or invalid sessionId');
    return;
  }

  if (Object.hasOwn(transports.sse, sessionId)) {
    const transport = transports.sse[sessionId];
    transport.handlePostMessage(req, res, req.body).catch(next);
  } else {
    res.status(400).send('No transport found for sessionId');
  }
});

// 监听3000端口并启动
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Sequential Thinking MCP Server HTTP SSE MODE Started.....");
    console.log(`Sequential Thinking MCP Server running on SSE at http://localhost:${PORT}/sse`);
  })
  .on('error', (err) => {
    console.error(`Sequential Thinking MCP Server error`, err);
    process.exitCode = 1;
  });
