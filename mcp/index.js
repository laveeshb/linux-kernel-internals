#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// The live Cloudflare API endpoint
const API_URL = "https://api.kernel-internals.org/api/search";

// Identifies this traffic to the Worker as coming from the official MCP
// server rather than an anonymous script, so it gets its own rate-limit
// bucket instead of the anonymous-browser one and skips the Turnstile
// bot-check (which a stdio process can't complete).
//
// This is NOT a cryptographic secret — it ships in this published package,
// so anyone can read it. Its purpose is traffic segmentation and a kill
// switch (the server owner can rotate MCP_SHARED_KEY to invalidate every
// copy in the wild), not access control. Override via env var if you're
// running your own private deployment with your own key.
const API_KEY = process.env.KERNEL_INTERNALS_API_KEY || "mcp-public-client-v1";

const server = new Server({
  name: "linux-kernel-internals",
  version: "1.0.0",
}, {
  capabilities: {
    tools: {}
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_kernel_internals",
        description: "Search the comprehensive Linux Kernel Internals documentation for explanations, design decisions, and architectural details.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The technical question or topic to search for (e.g., 'How does the clocksource watchdog fail?')"
            }
          },
          required: ["query"]
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "search_kernel_internals") {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const { query } = request.params.arguments;
  
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": API_KEY,
      },
      body: JSON.stringify({ query })
    });
    
    if (!res.ok) {
      throw new Error(`API returned ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    
    // Format the results
    const textOutput = data.results.map((r, i) => `[Result ${i + 1} from ${r.source}]\n${r.text}`).join('\n\n---\n\n');
    
    return {
      content: [{ type: "text", text: textOutput || "No results found." }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error searching documentation: ${error.message}` }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Linux Kernel Internals MCP Server running on stdio");
}

main().catch(console.error);
