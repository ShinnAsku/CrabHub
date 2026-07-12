#!/usr/bin/env node
/**
 * CrabHub CLI — query databases through a running CrabHub desktop app.
 *
 * Talks to CrabHub's local JSON-RPC server (127.0.0.1:3030), reusing the
 * connections already configured in the app. Credentials never leave the app.
 *
 * Zero dependencies — requires Node >= 18 (built-in fetch).
 *
 * Usage:
 *   crabhub connections list [--json]
 *   crabhub tables <connection-id> [--json]
 *   crabhub columns <connection-id> <table> [--schema <schema>] [--json]
 *   crabhub query <connection-id> "<sql>" [--json]
 */

import { parseArgs } from "node:util";

const CRABHUB_RPC_URL = process.env.CRABHUB_RPC_URL || "http://127.0.0.1:3030";

let rpcId = 0;
async function rpc(method, params) {
  let res;
  try {
    res = await fetch(CRABHUB_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    });
  } catch {
    fail(
      `Cannot reach CrabHub at ${CRABHUB_RPC_URL}.\n` +
        "Is the CrabHub desktop app running?"
    );
  }
  if (!res.ok) fail(`CrabHub RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) fail(body.error.message || JSON.stringify(body.error));
  return body.result;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** Render an array of flat objects as an aligned text table. */
function printTable(rows, columns) {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => (v === null || v === undefined ? "" : String(v));
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => cell(r[c]).length))
  );
  const line = (vals) =>
    vals.map((v, i) => v.padEnd(widths[i])).join("  ");
  console.log(line(cols));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => cell(r[c]))));
}

function usage() {
  console.log(`CrabHub CLI

Usage:
  crabhub connections list [--json]
  crabhub tables <connection-id> [--json]
  crabhub columns <connection-id> <table> [--schema <schema>] [--json]
  crabhub query <connection-id> "<sql>" [--json]

Environment:
  CRABHUB_RPC_URL   RPC endpoint (default http://127.0.0.1:3030)

The CrabHub desktop app must be running with the target connection open.`);
}

const { values: flags, positionals } = parseArgs({
  options: {
    json: { type: "boolean", default: false },
    schema: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  allowPositionals: true,
});

const [command, ...rest] = positionals;

function out(data, humanFn) {
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn(data);
  }
}

switch (flags.help ? "help" : command) {
  case "connections": {
    if (rest[0] !== "list") fail("usage: crabhub connections list [--json]");
    const conns = await rpc("list_connections", []);
    out(conns, (c) =>
      printTable(c, ["id", "name", "dbType", "host", "database", "healthy"])
    );
    break;
  }

  case "tables": {
    const [cid] = rest;
    if (!cid) fail("usage: crabhub tables <connection-id> [--json]");
    const tables = await rpc("list_tables", [cid]);
    out(tables, (t) =>
      printTable(t, ["schema", "name", "tableType", "rowCount", "primaryKey"])
    );
    break;
  }

  case "columns": {
    const [cid, table] = rest;
    if (!cid || !table)
      fail("usage: crabhub columns <connection-id> <table> [--schema <schema>] [--json]");
    const cols = await rpc("get_columns", [cid, table, flags.schema ?? null]);
    out(cols, (c) =>
      printTable(c, ["name", "dataType", "nullable", "isPrimaryKey", "defaultValue"])
    );
    break;
  }

  case "query": {
    const [cid, sql] = rest;
    if (!cid || !sql) fail('usage: crabhub query <connection-id> "<sql>" [--json]');
    const isQuery = /^\s*(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)\b/i.test(sql);
    const result = await rpc(isQuery ? "execute_query" : "execute_sql", [cid, sql]);
    if (result && result.error) fail(result.error);
    out(result, (r) => {
      if (r.rows) {
        printTable(r.rows, r.columns?.map((c) => c.name));
        console.log(`\n${r.rowCount} row(s) in ${r.executionTimeMs} ms`);
      } else {
        console.log(`${r.rowsAffected} row(s) affected in ${r.executionTimeMs} ms`);
      }
    });
    break;
  }

  case "help":
  case undefined:
    usage();
    break;

  default:
    fail(`unknown command: ${command}\n`);
}
