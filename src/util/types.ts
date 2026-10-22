import { google } from 'googleapis';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

/** Token file format — backward compatible with existing Go server at ~/.google-mcp-accounts/ */
export interface TokenFileData {
  email: string;
  name: string;
  picture: string;
  token: {
    access_token: string;
    token_type: string;
    refresh_token: string;
    expiry: string;
    expires_in: number;
  };
  last_used: string;
  token_file: string;
  /** Name of the OAuth client that issued this token. Absent on accounts saved before named clients existed. */
  client?: string;
}

/** Resolves an account email to an authenticated OAuth2Client. Defaults to GOOGLE_DEFAULT_ACCOUNT, else the most recently used account. */
export type GetAuthClient = (accountEmail?: string) => Promise<OAuth2Client>;

/** Standard MCP tool response — index signature needed for MCP SDK compatibility. */
export interface ToolResponse {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** Contract each service module must satisfy. */
export interface ServiceModule {
  tools: Tool[];
  register: (
    handleCall: (name: string, handler: (args: Record<string, unknown>) => Promise<ToolResponse>) => void,
    getAuth: GetAuthClient
  ) => void;
}
