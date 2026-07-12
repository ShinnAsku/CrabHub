/**
 * SQL dialect conversion — shares TYPE_MAPPINGS with the migration feature so
 * manual conversion and cross-database migration never drift apart.
 *
 * Design: line-oriented regex transforms with an explicit warnings channel.
 * We deliberately do NOT parse SQL fully; anything we cannot convert safely
 * is left in place and surfaced as a warning so the user stays in control.
 */

import { TYPE_MAPPINGS, mapType } from "./migration";

export interface ConvertResult {
  sql: string;
  warnings: string[];
}

const PG_FAMILY = ["postgresql", "gaussdb", "opengauss", "kingbase", "vastbase", "yashandb"];
const MYSQL_FAMILY = ["mysql", "oceanbase", "tidb", "tdsql"];

export function dialectFamily(dbType: string): "pg" | "mysql" | "sqlite" | "other" {
  const t = dbType.toLowerCase();
  if (PG_FAMILY.includes(t)) return "pg";
  if (MYSQL_FAMILY.includes(t)) return "mysql";
  if (t === "sqlite") return "sqlite";
  return "other";
}

/** Databases offered as conversion targets in the UI. */
export const CONVERT_TARGETS = [
  "postgresql", "gaussdb", "kingbase", "vastbase", "yashandb",
  "mysql", "oceanbase", "tidb", "sqlite",
];

export function convertSql(sql: string, from: string, to: string): ConvertResult {
  const fromFam = dialectFamily(from);
  const toFam = dialectFamily(to);
  const warnings: string[] = [];

  if (from === to) return { sql, warnings };

  let out = sql;

  if (fromFam === toFam) {
    // Same wire family — mostly compatible; flag known engine-specific gaps.
    if (fromFam === "pg") {
      if (to === "gaussdb" || to === "opengauss") {
        if (/GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY/i.test(out)) {
          warnings.push("GaussDB 对 IDENTITY 列支持有限，建议改用 SERIAL / 序列");
        }
        if (/\bUNLOGGED\b/i.test(out)) {
          warnings.push("GaussDB 不支持 UNLOGGED 表，已保留原文，请人工确认");
        }
      }
      if (from === "gaussdb" && to === "postgresql" && /\bDISTRIBUTE\s+BY\b/i.test(out)) {
        out = out.replace(/\s*DISTRIBUTE\s+BY\s+\w+\s*\([^)]*\)/gi, "");
        warnings.push("已移除 GaussDB 的 DISTRIBUTE BY 分布键子句（PG 无此概念）");
      }
    }
    return { sql: out, warnings };
  }

  if (fromFam === "mysql" && (toFam === "pg" || toFam === "sqlite")) {
    return mysqlToPg(out, from, to, warnings, toFam === "sqlite");
  }
  if (fromFam === "pg" && toFam === "mysql") {
    return pgToMysql(out, from, to, warnings);
  }
  if (fromFam === "pg" && toFam === "sqlite") {
    return pgToSqlite(out, from, to, warnings);
  }

  warnings.push(`暂不支持 ${from} → ${to} 的自动转换，已返回原文`);
  return { sql: out, warnings };
}

// ---------------------------------------------------------------------------

function applyTypeMappings(sql: string, from: string, to: string, warnings: string[]): string {
  const key = `${normalizeFamilyKey(from)}->${normalizeFamilyKey(to)}`;
  const mappings = TYPE_MAPPINGS[key];
  if (!mappings) return sql;
  let out = sql;
  // Longest-first so e.g. "BIGINT AUTO_INCREMENT" wins over "BIGINT".
  const entries = Object.entries(mappings).sort((a, b) => b[0].length - a[0].length);
  for (const [src, dst] of entries) {
    const pattern = new RegExp(`\\b${escapeRegex(src)}\\b`, "gi");
    out = out.replace(pattern, dst);
  }
  void warnings;
  return out;
}

/** TYPE_MAPPINGS keys use the canonical family representative. */
function normalizeFamilyKey(dbType: string): string {
  const fam = dialectFamily(dbType);
  if (fam === "pg") return "postgresql";
  if (fam === "mysql") return "mysql";
  return dbType.toLowerCase();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mysqlToPg(sql: string, from: string, to: string, warnings: string[], toSqlite: boolean): ConvertResult {
  let out = sql;

  // Backtick identifiers → double quotes
  out = out.replace(/`([^`]*)`/g, '"$1"');

  // Collect table name for COMMENT ON statements
  const tableMatch = out.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"(?:\."[^"]+")?|\S+)/i);
  const tableName = tableMatch?.[1] ?? "";

  // Inline column comments → COMMENT ON COLUMN (PG) / dropped with warning (SQLite)
  const commentStatements: string[] = [];
  out = out.replace(/^(\s*"([^"]+)"[^\n]*?)\s+COMMENT\s+'((?:[^']|'')*)'/gim, (_m, lineStart, colName, comment) => {
    if (toSqlite) {
      warnings.push(`SQLite 不支持列注释，已移除列 ${colName} 的注释`);
    } else if (tableName) {
      commentStatements.push(`COMMENT ON COLUMN ${tableName}."${colName}" IS '${comment}';`);
    }
    return lineStart;
  });

  // Table options: ENGINE / CHARSET / COLLATE / AUTO_INCREMENT=n / ROW_FORMAT / table COMMENT
  out = out.replace(/\)\s*(ENGINE|DEFAULT\s+CHARSET|CHARSET|COLLATE|AUTO_INCREMENT|ROW_FORMAT|COMMENT)[^;]*/gi, (m) => {
    const tblComment = m.match(/COMMENT\s*=?\s*'((?:[^']|'')*)'/i);
    if (tblComment && !toSqlite && tableName) {
      commentStatements.push(`COMMENT ON TABLE ${tableName} IS '${tblComment[1]}';`);
    }
    return ")";
  });

  // UNSIGNED has no PG equivalent
  if (/\bUNSIGNED\b/i.test(out)) {
    out = out.replace(/\s+UNSIGNED\b/gi, "");
    warnings.push("已移除 UNSIGNED（PG/SQLite 无对应概念，请确认取值范围）");
  }

  // ON UPDATE CURRENT_TIMESTAMP → trigger territory
  if (/ON\s+UPDATE\s+CURRENT_TIMESTAMP/i.test(out)) {
    out = out.replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(\(\d*\))?/gi, "");
    warnings.push("已移除 ON UPDATE CURRENT_TIMESTAMP，PG 需用触发器实现同等行为");
  }

  out = applyTypeMappings(out, from, to, warnings);

  if (commentStatements.length > 0) {
    out = out.trimEnd();
    if (!out.endsWith(";")) out += ";";
    out += "\n\n" + commentStatements.join("\n");
  }

  return { sql: out, warnings };
}

function pgToMysql(sql: string, from: string, to: string, warnings: string[]): ConvertResult {
  let out = sql;

  // COMMENT ON TABLE → ALTER TABLE ... COMMENT
  out = out.replace(/COMMENT\s+ON\s+TABLE\s+(\S+)\s+IS\s+'((?:[^']|'')*)'\s*;/gi,
    (_m, tbl, comment) => `ALTER TABLE ${tbl} COMMENT = '${comment}';`);

  // COMMENT ON COLUMN cannot be translated without the full column definition
  if (/COMMENT\s+ON\s+COLUMN/i.test(out)) {
    out = out.replace(/^\s*COMMENT\s+ON\s+COLUMN[^;]*;\s*$/gim, "");
    warnings.push("MySQL 的列注释需内联在列定义中，COMMENT ON COLUMN 语句已移除，请手工补充");
  }

  // Double-quoted identifiers → backticks
  out = out.replace(/"([^"]*)"/g, "`$1`");

  out = applyTypeMappings(out, from, to, warnings);

  if (/CREATE\s+(UNIQUE\s+)?INDEX/i.test(out) && /\bWHERE\b/i.test(out)) {
    warnings.push("MySQL 不支持部分索引（partial index），相关 WHERE 子句需人工处理");
  }

  return { sql: out, warnings };
}

function pgToSqlite(sql: string, from: string, to: string, warnings: string[]): ConvertResult {
  let out = sql;

  if (/COMMENT\s+ON\s+(TABLE|COLUMN)/i.test(out)) {
    out = out.replace(/^\s*COMMENT\s+ON\s+(TABLE|COLUMN)[^;]*;\s*$/gim, "");
    warnings.push("SQLite 不支持注释语句，COMMENT ON 已移除");
  }

  out = applyTypeMappings(out, from, to, warnings);

  if (/\bSERIAL\b/i.test(sql)) {
    warnings.push("SQLite 自增请确认主键列为 INTEGER PRIMARY KEY（已按映射转换）");
  }

  return { sql: out, warnings };
}

/** Human-readable conversion header prepended to converted scripts. */
export function conversionHeader(from: string, to: string, warnings: string[]): string {
  const lines = [`-- Converted: ${from} → ${to} (CrabHub)`];
  for (const w of warnings) lines.push(`-- ⚠ ${w}`);
  return lines.join("\n") + "\n\n";
}

// re-export for UI convenience
export { mapType };
