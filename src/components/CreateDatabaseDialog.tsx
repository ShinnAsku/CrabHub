import { useState, useEffect } from "react";
import { Database, X, Check, Loader2 } from "lucide-react";
import type { Connection } from "@/types";
import { executeQuery, executeSql } from "@/lib/tauri-commands";
import { t } from "@/lib/i18n";

interface CreateDatabaseDialogProps {
  isOpen: boolean;
  onClose: () => void;
  connectionId: string;
  connectionType: Connection["type"];
  connectionName: string;
  onSuccess: (connectionId: string) => void;
}

type DbType = Connection["type"];

const isPgLike = (type: DbType) =>
  type === "postgresql" || type === "gaussdb";

const CLICKHOUSE_ENGINES = ["Atomic", "Lazy", "Ordinary", "Memory"];

function buildCreateDatabaseSQL(
  type: DbType,
  dbName: string,
  opts: {
    owner?: string;
    encoding?: string;
    collation?: string;
    lcCtype?: string;
    template?: string;
    tablespace?: string;
    connectionLimit?: number;
    allowConnections?: boolean;
    isTemplate?: boolean;
    charset?: string;
    mysqlCollation?: string;
    engine?: string;
  }
): string {
  const escapedName = dbName.replace(/"/g, '""');

  if (isPgLike(type)) {
    const clauses: string[] = [];
    if (opts.owner) clauses.push(`OWNER = ${opts.owner}`);
    if (opts.encoding) clauses.push(`ENCODING = '${opts.encoding}'`);
    if (opts.collation) clauses.push(`LC_COLLATE = '${opts.collation}'`);
    if (opts.lcCtype) clauses.push(`LC_CTYPE = '${opts.lcCtype}'`);
    if (opts.template) clauses.push(`TEMPLATE = ${opts.template}`);
    if (opts.tablespace) clauses.push(`TABLESPACE = ${opts.tablespace}`);
    if (opts.connectionLimit !== undefined && opts.connectionLimit !== -1)
      clauses.push(`CONNECTION LIMIT = ${opts.connectionLimit}`);
    if (opts.allowConnections === false)
      clauses.push(`ALLOW_CONNECTIONS = false`);
    if (opts.isTemplate === true) clauses.push(`IS_TEMPLATE = true`);

    let sql = `CREATE DATABASE "${escapedName}"`;
    if (clauses.length > 0) {
      sql += `\n  WITH ${clauses.join("\n       ")}`;
    }
    return sql + ";";
  }

  if (type === "mysql") {
    const backtickName = dbName.replace(/`/g, "``");
    let sql = `CREATE DATABASE \`${backtickName}\``;
    if (opts.charset) sql += `\n  CHARACTER SET ${opts.charset}`;
    if (opts.mysqlCollation) sql += `\n  COLLATE ${opts.mysqlCollation}`;
    return sql + ";";
  }

  if (type === "mssql") {
    const bracketName = dbName.replace(/]/g, "]]");
    return `CREATE DATABASE [${bracketName}];`;
  }

  if (type === "clickhouse") {
    let sql = `CREATE DATABASE ${escapedName}`;
    if (opts.engine) sql += ` ENGINE = ${opts.engine}`;
    return sql + ";";
  }

  return `CREATE DATABASE "${escapedName}";`;
}

function CreateDatabaseDialog({
  isOpen,
  onClose,
  connectionId,
  connectionType,
  connectionName,
  onSuccess,
}: CreateDatabaseDialogProps) {
  // Form state
  const [dbName, setDbName] = useState("");
  const [owner, setOwner] = useState("");
  const [encoding, setEncoding] = useState("");
  const [collation, setCollation] = useState("");
  const [lcCtype, setLcCtype] = useState("");
  const [template, setTemplate] = useState("");
  const [tablespace, setTablespace] = useState("");
  const [connectionLimit, setConnectionLimit] = useState(-1);
  const [allowConnections, setAllowConnections] = useState(true);
  const [isTemplate, setIsTemplate] = useState(false);
  const [charset, setCharset] = useState("");
  const [mysqlCollation, setMysqlCollation] = useState("");
  const [engine, setEngine] = useState("Atomic");

  // Dynamic options
  const [ownerOptions, setOwnerOptions] = useState<string[]>([]);
  const [encodingOptions, setEncodingOptions] = useState<string[]>([]);
  const [collationOptions, setCollationOptions] = useState<string[]>([]);
  const [templateOptions, setTemplateOptions] = useState<string[]>([]);
  const [tablespaceOptions, setTablespaceOptions] = useState<string[]>([]);
  const [charsetOptions, setCharsetOptions] = useState<string[]>([]);
  const [allMysqlCollations, setAllMysqlCollations] = useState<
    { collation: string; charset: string }[]
  >([]);
  const [optionsLoading, setOptionsLoading] = useState(false);

  // UI state
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (isOpen) {
      setDbName("");
      setOwner("");
      setEncoding("");
      setCollation("");
      setLcCtype("");
      setTemplate("");
      setTablespace("");
      setConnectionLimit(-1);
      setAllowConnections(true);
      setIsTemplate(false);
      setCharset("");
      setMysqlCollation("");
      setEngine("Atomic");
      setError(null);
      setCreating(false);
    }
  }, [isOpen]);

  // Load dynamic options when dialog opens
  useEffect(() => {
    if (!isOpen) return;

    const loadOptions = async () => {
      setOptionsLoading(true);
      try {
        if (isPgLike(connectionType)) {
          const queries = [
            {
              sql: "SELECT rolname FROM pg_catalog.pg_roles ORDER BY rolname",
              setter: setOwnerOptions,
              key: "rolname",
            },
            {
              sql: "SELECT spcname FROM pg_catalog.pg_tablespace ORDER BY spcname",
              setter: setTablespaceOptions,
              key: "spcname",
            },
            {
              sql: "SELECT pg_encoding_to_char(i) as encoding FROM generate_series(0, 100) i WHERE pg_encoding_to_char(i) != '' ORDER BY encoding",
              setter: setEncodingOptions,
              key: "encoding",
            },
            {
              sql: "SELECT DISTINCT collname FROM pg_catalog.pg_collation ORDER BY collname LIMIT 500",
              setter: setCollationOptions,
              key: "collname",
            },
            {
              sql: "SELECT datname FROM pg_catalog.pg_database WHERE datistemplate ORDER BY datname",
              setter: setTemplateOptions,
              key: "datname",
            },
          ];

          const results = await Promise.allSettled(
            queries.map((q) => executeQuery(connectionId, q.sql))
          );

          results.forEach((result, idx) => {
            if (result.status === "fulfilled" && result.value.rows) {
              const key = queries[idx]!.key;
              const values = result.value.rows
                .map((row: Record<string, unknown>) => String(row[key] || ""))
                .filter(Boolean);
              queries[idx]!.setter(values);
            }
          });
        } else if (connectionType === "mysql") {
          const [charsetResult, collationResult] = await Promise.allSettled([
            executeQuery(connectionId, "SHOW CHARACTER SET"),
            executeQuery(connectionId, "SHOW COLLATION"),
          ]);

          if (
            charsetResult.status === "fulfilled" &&
            charsetResult.value.rows
          ) {
            const charsets = charsetResult.value.rows
              .map(
                (row: Record<string, unknown>) =>
                  String(row["Charset"] || row["charset"] || "")
              )
              .filter(Boolean);
            setCharsetOptions(charsets);
          }

          if (
            collationResult.status === "fulfilled" &&
            collationResult.value.rows
          ) {
            const collations = collationResult.value.rows.map(
              (row: Record<string, unknown>) => ({
                collation: String(
                  row["Collation"] || row["collation"] || ""
                ),
                charset: String(row["Charset"] || row["charset"] || ""),
              })
            );
            setAllMysqlCollations(collations);
          }
        }
      } catch (err) {
        console.error("[CreateDatabaseDialog] Failed to load options:", err);
      } finally {
        setOptionsLoading(false);
      }
    };

    loadOptions();
  }, [isOpen, connectionId, connectionType]);

  // Filtered MySQL collations based on selected charset
  const filteredMysqlCollations = charset
    ? allMysqlCollations
        .filter((c) => c.charset === charset)
        .map((c) => c.collation)
    : allMysqlCollations.map((c) => c.collation);

  const handleCreate = async () => {
    if (!dbName.trim()) {
      setError(t("createDb.nameRequired"));
      return;
    }

    setError(null);
    setCreating(true);

    try {
      const sql = buildCreateDatabaseSQL(connectionType, dbName.trim(), {
        owner: owner || undefined,
        encoding: encoding || undefined,
        collation: collation || undefined,
        lcCtype: lcCtype || undefined,
        template: template || undefined,
        tablespace: tablespace || undefined,
        connectionLimit,
        allowConnections,
        isTemplate,
        charset: charset || undefined,
        mysqlCollation: mysqlCollation || undefined,
        engine: engine || undefined,
      });

      console.log("[CreateDatabaseDialog] Executing SQL:", sql);
      await executeSql(connectionId, sql);

      onSuccess(connectionId);
      onClose();
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      console.error("[CreateDatabaseDialog] Failed:", err);
    } finally {
      setCreating(false);
    }
  };

  if (!isOpen) return null;

  const selectClass =
    "w-full px-2 py-1.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))] text-foreground";
  const inputClass = selectClass;
  const labelClass = "text-xs text-muted-foreground whitespace-nowrap w-20 shrink-0 text-right";

  const renderPgFields = () => (
    <>
      {/* Owner */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.owner")}</label>
        <select
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          className={selectClass}
        >
          <option value="">{t("createDb.default")}</option>
          {ownerOptions.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>

      {/* Encoding */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.encoding")}</label>
        <select
          value={encoding}
          onChange={(e) => setEncoding(e.target.value)}
          className={selectClass}
        >
          <option value="">{t("createDb.default")}</option>
          {encodingOptions.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>

      {/* Collation */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.collation")}</label>
        <select
          value={collation}
          onChange={(e) => setCollation(e.target.value)}
          className={selectClass}
        >
          <option value="">{t("createDb.default")}</option>
          {collationOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {/* LC_CTYPE */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.lcCtype")}</label>
        <select
          value={lcCtype}
          onChange={(e) => setLcCtype(e.target.value)}
          className={selectClass}
        >
          <option value="">{t("createDb.default")}</option>
          {collationOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {/* Template */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.template")}</label>
        <select
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          className={selectClass}
        >
          <option value="">{t("createDb.default")}</option>
          {templateOptions.map((tp) => (
            <option key={tp} value={tp}>
              {tp}
            </option>
          ))}
        </select>
      </div>

      {/* Tablespace */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.tablespace")}</label>
        <select
          value={tablespace}
          onChange={(e) => setTablespace(e.target.value)}
          className={selectClass}
        >
          <option value="">{t("createDb.default")}</option>
          {tablespaceOptions.map((ts) => (
            <option key={ts} value={ts}>
              {ts}
            </option>
          ))}
        </select>
      </div>

      {/* Connection Limit */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.connectionLimit")}</label>
        <div className="flex items-center gap-2 flex-1">
          <input
            type="number"
            value={connectionLimit}
            onChange={(e) => setConnectionLimit(parseInt(e.target.value) || -1)}
            className={inputClass}
            min={-1}
          />
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            -1 = {t("createDb.unlimited")}
          </span>
        </div>
      </div>

      {/* Allow Connections */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.allowConnections")}</label>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={allowConnections}
            onChange={(e) => setAllowConnections(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-8 h-4 bg-muted rounded-full peer peer-checked:bg-[hsl(var(--tab-active))] transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4" />
        </label>
      </div>

      {/* Is Template */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.isTemplate")}</label>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={isTemplate}
            onChange={(e) => setIsTemplate(e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-8 h-4 bg-muted rounded-full peer peer-checked:bg-[hsl(var(--tab-active))] transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4" />
        </label>
      </div>
    </>
  );

  const renderMysqlFields = () => (
    <>
      {/* Charset */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.charset")}</label>
        <select
          value={charset}
          onChange={(e) => {
            setCharset(e.target.value);
            setMysqlCollation("");
          }}
          className={selectClass}
        >
          <option value="">{t("createDb.default")}</option>
          {charsetOptions.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {/* Collation */}
      <div className="flex items-center gap-3">
        <label className={labelClass}>{t("createDb.collation")}</label>
        <select
          value={mysqlCollation}
          onChange={(e) => setMysqlCollation(e.target.value)}
          className={selectClass}
        >
          <option value="">{t("createDb.default")}</option>
          {filteredMysqlCollations.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
    </>
  );

  const renderClickhouseFields = () => (
    <div className="flex items-center gap-3">
      <label className={labelClass}>{t("createDb.engine")}</label>
      <select
        value={engine}
        onChange={(e) => setEngine(e.target.value)}
        className={selectClass}
      >
        {CLICKHOUSE_ENGINES.map((eng) => (
          <option key={eng} value={eng}>
            {eng}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Dialog */}
      <div className="relative w-[480px] max-h-[85vh] bg-background border border-border rounded-lg shadow-xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Database size={15} className="text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">
              {t("createDb.title")}
            </span>
            <span className="text-xs text-muted-foreground">
              - {connectionName}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Form Content */}
        <div className="px-4 py-4 overflow-y-auto flex-1 space-y-3">
          {optionsLoading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
              <Loader2 size={12} className="animate-spin" />
              <span>{t("common.loading")}</span>
            </div>
          )}

          {/* Database Name - always shown */}
          <div className="flex items-center gap-3">
            <label className={labelClass}>
              {t("createDb.databaseName")}
              <span className="text-red-500 ml-0.5">*</span>
            </label>
            <input
              type="text"
              value={dbName}
              onChange={(e) => {
                setDbName(e.target.value);
                if (error) setError(null);
              }}
              placeholder={t("createDb.databaseName")}
              className={inputClass}
              autoFocus
            />
          </div>

          {/* Type-specific fields */}
          {isPgLike(connectionType) && renderPgFields()}
          {connectionType === "mysql" && renderMysqlFields()}
          {connectionType === "clickhouse" && renderClickhouseFields()}
          {/* MSSQL: only database name, no additional fields */}

          {/* Error message */}
          {error && (
            <div className="flex items-start gap-1.5 px-2.5 py-2 rounded text-xs bg-destructive/10 text-destructive">
              <X size={12} className="shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !dbName.trim()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-40"
          >
            {creating ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Check size={12} />
            )}
            {creating ? t("createDb.creating") : t("createDb.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

export default CreateDatabaseDialog;
