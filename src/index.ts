#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolResponse } from './util/types.js';
import { getAuthClient } from './auth/accounts.js';
import { withReauthRetry } from './auth/reauth.js';
import { SERVER_INSTRUCTIONS } from './util/account-docs.js';

import * as accountsService from './services/accounts.js';
import * as driveService from './services/drive.js';
import * as sheetsService from './services/sheets.js';
import * as docsService from './services/docs.js';
import * as gmailService from './services/gmail.js';
import * as calendarService from './services/calendar.js';
import * as slidesService from './services/slides.js';
import * as groupsService from './services/groups.js';

const services = [
  accountsService,
  driveService,
  sheetsService,
  docsService,
  gmailService,
  calendarService,
  slidesService,
  groupsService,
];

const allTools: Tool[] = services.flatMap(s => s.tools);

const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResponse>>();

function handleCall(
  name: string,
  handler: (args: Record<string, unknown>) => Promise<ToolResponse>
): void {
  if (handlers.has(name)) {
    throw new Error(`Duplicate tool handler: ${name}`);
  }
  handlers.set(name, withReauthRetry(handler));
}

for (const svc of services) {
  svc.register(handleCall, getAuthClient);
}

const server = new Server(
  { name: 'google-workspace-mcp', version: '0.3.0' },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: allTools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers.get(name);
  if (!handler) {
    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
  }
  try {
    return await handler(args || {});
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${msg}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Google Workspace MCP server running (${allTools.length} tools)`);
