#!/usr/bin/env node
/**
 * CrabHub MCP Server — stdio bridge to a running CrabHub desktop app.
 *
 * Speaks Model Context Protocol (newline-delimited JSON-RPC 2.0 on stdio)
 * and forwards tool calls to CrabHub's local JSON-RPC server (127.0.0.1:3030),
 * so MCP clients (Claude Code / Cursor / VS Code / ...) can query databases
 * through connections already configured in CrabHub.
 *
 * Zero dependencies — requires Node >= 18 (built-in fetch).
 *
 * Usage: node index.mjs   (CrabHub app must be running)
 */

import { createInterface } from "node:readline";

const CRABHUB_RPC_URL = process.env.CRABHUB_RPC_URL || "http://127.0.0.1:3030";

let rpcId = 0;
async function crabhubRpc(method, params) {
  const res = await fetch(CRABHUB_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`CrabHub RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
  return body.result;
}

const TOOLS = [
  {
    name: "list_connections",
    description:
      "List database connections currently open in the CrabHub app (id, name, dbType, host, database, health).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_tables",
    description: "List tables for a CrabHub connection.",
    inputSchema: {
      type: "object",
      properties: { connectionId: { type: "string", description: "Connection id from list_connections" } },
      required: ["connectionId"],
    },
  },
  {
    name: "get_columns",
    description: "Get column metadata for a table.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        table: { type: "string" },
        schema: { type: "string", description: "Optional schema name" },
      },
      required: ["connectionId", "table"],
    },
  },
  {
    name: "execute_sql",
    description:
      "Execute a SQL query on a CrabHub connection and return rows as JSON. SELECT queries return result sets; DML/DDL return affected-row counts.",
    inputSchema: {
      type: "object",
      properties: {
        connectionId: { type: "string" },
        sql: { type: "string" },
      },
      required: ["connectionId", "sql"],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "list_connections":
      return crabhubRpc("list_connections", []);
    case "list_tables":
      return crabhubRpc("list_tables", [args.connectionId]);
    case "get_columns":
      return crabhubRpc("get_columns", [args.connectionId, args.table, args.schema ?? null]);
    case "execute_sql": {
      const isQuery = /^\s*(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i.test(args.sql);
      return crabhubRpc(isQuery ? "execute_query" : "execute_sql", [args.connectionId, args.sql]);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "crabhub-mcp", version: "0.1.0" },
      });
      break;
    case "notifications/initialized":
    case "notifications/cancelled":
      break; // notifications need no response
    case "ping":
      reply(id, {});
      break;
    case "tools/list":
      reply(id, { tools: TOOLS });
      break;
    case "tools/call": {
      try {
        const result = await callTool(params.name, params.arguments || {});
        reply(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
      }
      break;
    }
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

let pending = 0;
let stdinClosed = false;

function maybeExit() {
  if (stdinClosed && pending === 0) process.exit(0);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // ignore malformed lines
  }
  pending++;
  handle(msg)
    .catch((e) => {
      if (msg.id !== undefined) replyError(msg.id, -32603, e.message);
    })
    .finally(() => {
      pending--;
      maybeExit();
    });
});
// Drain in-flight requests before exiting — a hard exit here would drop
// responses for tools/call still awaiting the CrabHub RPC round-trip.
rl.on("close", () => {
  stdinClosed = true;
  maybeExit();
});
