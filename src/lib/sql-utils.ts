// Pure SQL utilities extracted from EditorPanel.tsx — no React/UI deps, easy to
// unit-test in isolation.

export const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE",
  "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "VIEW", "DATABASE", "SCHEMA",
  "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "CROSS", "FULL", "ON", "USING",
  "AND", "OR", "NOT", "IN", "EXISTS", "BETWEEN", "LIKE", "ILIKE", "IS", "NULL",
  "AS", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "UNION", "ALL",
  "DISTINCT", "CASE", "WHEN", "THEN", "ELSE", "END", "CAST", "COALESCE",
  "COUNT", "SUM", "AVG", "MIN", "MAX", "ASC", "DESC", "NULLS", "FIRST", "LAST",
  "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE", "CHECK", "DEFAULT",
  "CONSTRAINT", "NOT", "NULL", "AUTO_INCREMENT", "SERIAL", "BIGSERIAL",
  "INTEGER", "INT", "BIGINT", "SMALLINT", "FLOAT", "DOUBLE", "DECIMAL", "NUMERIC",
  "VARCHAR", "CHAR", "TEXT", "BOOLEAN", "BOOL", "DATE", "TIME", "TIMESTAMP",
  "TIMESTAMPTZ", "JSON", "JSONB", "UUID", "BYTEA", "BLOB", "CLOB",
  "IF", "ELSE", "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "TRANSACTION",
  "GRANT", "REVOKE", "WITH", "RECURSIVE", "RETURNING", "EXPLAIN", "ANALYZE",
  "TRUNCATE", "CASCADE", "RESTRICT", "TRIGGER", "FUNCTION", "PROCEDURE",
  "EXECUTE", "REPLACE", "MERGE", "UPSERT", "CONFLICT", "DO", "NOTHING",
  "PARTITION", "OVER", "WINDOW", "ROW_NUMBER", "RANK", "DENSE_RANK",
  "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "NTH_VALUE", "NTILE",
  "FETCH", "NEXT", "ROWS", "ONLY", "PERCENT", "TOP", "PIVOT", "UNPIVOT",
  "SHOW", "DESCRIBE", "DESC", "USE", "RENAME", "TO", "ADD", "COLUMN",
  "MATERIALIZED", "REFRESH", "CONCURRENTLY", "LATERAL", "TABLESAMPLE",
  "GROUPING", "SETS", "CUBE", "ROLLUP", "FILTER", "WITHIN", "ARRAY",
];

// Split SQL text into individual statements, respecting strings, comments,
// dollar-quotes, and BEGIN...END blocks.
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const len = sql.length;
  let blockDepth = 0;

  // Whether the current accumulating statement starts a BEGIN-introducible block
  // (CREATE FUNCTION/PROCEDURE/TRIGGER, DO).
  function isBlockContext(): boolean {
    const stripped = current
      .replace(/--[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .toUpperCase()
      .trim();
    return (
      /\b(CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE|TRIGGER))\b/.test(stripped) ||
      /^\s*DO\b/.test(stripped)
    );
  }

  function readWord(): string | null {
    const m = sql.substring(i).match(/^[a-zA-Z_]\w*/);
    return m ? m[0] : null;
  }

  while (i < len) {
    const ch = sql.charAt(i);

    // Single-line comment
    if (ch === "-" && sql.charAt(i + 1) === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) {
        current += sql.substring(i);
        break;
      }
      current += sql.substring(i, nl + 1);
      i = nl + 1;
      continue;
    }

    // Multi-line comment
    if (ch === "/" && sql.charAt(i + 1) === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        current += sql.substring(i);
        break;
      }
      current += sql.substring(i, end + 2);
      i = end + 2;
      continue;
    }

    // Single-quoted string literal (with '' escape)
    if (ch === "'") {
      let j = i + 1;
      while (j < len) {
        if (sql.charAt(j) === "'" && sql.charAt(j + 1) === "'") {
          j += 2;
        } else if (sql.charAt(j) === "'") {
          break;
        } else {
          j++;
        }
      }
      current += sql.substring(i, j + 1);
      i = j + 1;
      continue;
    }

    // Dollar-quoted string (PostgreSQL)
    if (ch === "$") {
      const tagMatch = sql.substring(i).match(/^\$([a-zA-Z_]*)\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const endIdx = sql.indexOf(tag, i + tag.length);
        if (endIdx !== -1) {
          current += sql.substring(i, endIdx + tag.length);
          i = endIdx + tag.length;
          continue;
        }
      }
    }

    // Word token — track BEGIN/END block nesting
    if (/[a-zA-Z_]/.test(ch)) {
      const word = readWord();
      if (word) {
        const upper = word.toUpperCase();
        current += word;
        i += word.length;

        if (upper === "BEGIN") {
          if (blockDepth > 0 || isBlockContext()) {
            blockDepth++;
          }
          // else: standalone BEGIN (transaction) — do not track
        } else if (upper === "END" && blockDepth > 0) {
          blockDepth--;
        }
        continue;
      }
    }

    // Semicolon — statement boundary only when not inside a BEGIN...END block
    if (ch === ";") {
      if (blockDepth > 0) {
        current += ch;
        i++;
        continue;
      }
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  let lastStmt = current.trim();
  // Filter out a standalone "/" (Oracle/GaussDB block terminator).
  if (lastStmt === "/") lastStmt = "";
  if (lastStmt) statements.push(lastStmt);

  return statements.filter((s) => s !== "/");
}

// Render result rows as a GitHub-flavored Markdown table.
export function rowsToMarkdown(
  columns: { name: string }[],
  rows: Record<string, unknown>[],
): string {
  if (rows.length === 0) return "";
  const headers = columns.map((c) => c.name);
  const separator = headers.map(() => "---");

  const body = rows.map(
    (row) =>
      "| " +
      headers
        .map((h) => {
          const val = row[h];
          if (val === null || val === undefined) return "";
          return String(val).replace(/\|/g, "\\|").replace(/\n/g, " ");
        })
        .join(" | ") +
      " |",
  );

  return [
    "| " + headers.join(" | ") + " |",
    "| " + separator.join(" | ") + " |",
    ...body,
  ].join("\n");
}
