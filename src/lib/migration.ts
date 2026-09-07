import { executeQuery, executeSql, getTables, getColumns } from "@/lib/tauri-commands";
import { supportsBulkWrite, insertRowsBulk } from "@/lib/bulk-client";
import { generateCreateTable, type TableDef, type ColumnDef } from "@/lib/ddl-generator";
import type { Connection, ColumnInfo } from "@/types/index";

// ===== Types =====

export interface MigrationConfig {
  sourceConnectionId: string;
  targetConnectionId: string;
  sourceSchema?: string;
  targetSchema?: string;
  tables: string[];
  mode: 'structure' | 'data' | 'both';
  dropExisting: boolean;
  batchSize: number;
  stopOnError: boolean;
}

export interface MigrationProgress {
  currentTable: string;
  currentStep: 'creating' | 'copying' | 'done' | 'idle';
  tablesCompleted: number;
  totalTables: number;
  rowsCopied: number;
  totalRows: number;
  errors: string[];
  logs: string[];
  startTime: number;
  cancelled: boolean;
}

export interface TableMigrationInfo {
  name: string;
  schema?: string;
  rowCount?: number;
  selected: boolean;
}

// ===== Type Mappings =====

export const TYPE_MAPPINGS: Record<string, Record<string, string>> = {
  'postgresql->mysql': {
    'serial': 'INT AUTO_INCREMENT',
    'bigserial': 'BIGINT AUTO_INCREMENT',
    'smallserial': 'SMALLINT AUTO_INCREMENT',
    'text': 'LONGTEXT',
    'boolean': 'TINYINT(1)',
    'timestamp': 'DATETIME',
    'timestamptz': 'DATETIME',
    'jsonb': 'JSON',
    'uuid': 'CHAR(36)',
    'bytea': 'LONGBLOB',
    'numeric': 'DECIMAL',
    'double precision': 'DOUBLE',
    'character varying': 'VARCHAR',
    'character': 'CHAR',
    'real': 'FLOAT',
    'time': 'TIME',
    'date': 'DATE',
    'smallint': 'SMALLINT',
    'integer': 'INT',
    'bigint': 'BIGINT',
    'json': 'JSON',
    'inet': 'VARCHAR(45)',
    'cidr': 'VARCHAR(45)',
    'macaddr': 'VARCHAR(17)',
    'interval': 'VARCHAR(50)',
    'bit': 'BIT',
    'money': 'DECIMAL(19,4)',
    'xml': 'LONGTEXT',
  },
  'mysql->postgresql': {
    'INT AUTO_INCREMENT': 'SERIAL',
    'BIGINT AUTO_INCREMENT': 'BIGSERIAL',
    'SMALLINT AUTO_INCREMENT': 'SMALLSERIAL',
    'TINYINT(1)': 'BOOLEAN',
    'LONGTEXT': 'TEXT',
    'MEDIUMTEXT': 'TEXT',
    'TINYTEXT': 'TEXT',
    'DATETIME': 'TIMESTAMP',
    'JSON': 'JSONB',
    'DOUBLE': 'DOUBLE PRECISION',
    'BLOB': 'BYTEA',
    'MEDIUMBLOB': 'BYTEA',
    'LONGBLOB': 'BYTEA',
    'TINYBLOB': 'BYTEA',
    'DECIMAL': 'NUMERIC',
    'FLOAT': 'REAL',
    'YEAR': 'SMALLINT',
    'ENUM': 'VARCHAR',
    'SET': 'VARCHAR',
    'FIXED': 'DECIMAL',
    'NUMERIC': 'NUMERIC',
    'BIT': 'BIT',
    'DATE': 'DATE',
    'TIME': 'TIME',
    'CHAR': 'CHAR',
    'VARCHAR': 'VARCHAR',
    'TEXT': 'TEXT',
    'BOOLEAN': 'BOOLEAN',
    'INT': 'INTEGER',
    'BIGINT': 'BIGINT',
    'SMALLINT': 'SMALLINT',
    'MEDIUMINT': 'INTEGER',
    'TINYINT': 'SMALLINT',
  },
  'postgresql->sqlite': {
    'serial': 'INTEGER',
    'bigserial': 'INTEGER',
    'smallserial': 'INTEGER',
    'boolean': 'INTEGER',
    'timestamp': 'TEXT',
    'timestamptz': 'TEXT',
    'jsonb': 'TEXT',
    'json': 'TEXT',
    'uuid': 'TEXT',
    'bytea': 'BLOB',
    'numeric': 'REAL',
    'double precision': 'REAL',
    'character varying': 'TEXT',
    'character': 'TEXT',
    'real': 'REAL',
    'date': 'TEXT',
    'time': 'TEXT',
    'interval': 'TEXT',
    'money': 'REAL',
    'inet': 'TEXT',
    'cidr': 'TEXT',
    'macaddr': 'TEXT',
    'bit': 'INTEGER',
    'xml': 'TEXT',
  },
  'mysql->sqlite': {
    'INT AUTO_INCREMENT': 'INTEGER',
    'BIGINT AUTO_INCREMENT': 'INTEGER',
    'SMALLINT AUTO_INCREMENT': 'INTEGER',
    'TINYINT(1)': 'INTEGER',
    'LONGTEXT': 'TEXT',
    'MEDIUMTEXT': 'TEXT',
    'TINYTEXT': 'TEXT',
    'DATETIME': 'TEXT',
    'TIMESTAMP': 'TEXT',
    'JSON': 'TEXT',
    'DOUBLE': 'REAL',
    'BLOB': 'BLOB',
    'MEDIUMBLOB': 'BLOB',
    'LONGBLOB': 'BLOB',
    'TINYBLOB': 'BLOB',
    'DECIMAL': 'REAL',
    'FLOAT': 'REAL',
    'YEAR': 'INTEGER',
    'ENUM': 'TEXT',
    'SET': 'TEXT',
    'BIT': 'INTEGER',
    'BOOLEAN': 'INTEGER',
    'DATE': 'TEXT',
    'TIME': 'TEXT',
    'CHAR': 'TEXT',
    'VARCHAR': 'TEXT',
    'TEXT': 'TEXT',
    'INT': 'INTEGER',
    'BIGINT': 'INTEGER',
    'SMALLINT': 'INTEGER',
    'MEDIUMINT': 'INTEGER',
    'TINYINT': 'INTEGER',
    'NUMERIC': 'REAL',
  },
  'postgresql->mssql': {
    'serial': 'INT IDENTITY(1,1)',
    'bigserial': 'BIGINT IDENTITY(1,1)',
    'smallserial': 'SMALLINT IDENTITY(1,1)',
    'boolean': 'BIT',
    'text': 'NVARCHAR(MAX)',
    'character varying': 'NVARCHAR',
    'character': 'NCHAR',
    'timestamp': 'DATETIME2',
    'timestamptz': 'DATETIMEOFFSET',
    'jsonb': 'NVARCHAR(MAX)',
    'json': 'NVARCHAR(MAX)',
    'uuid': 'UNIQUEIDENTIFIER',
    'bytea': 'VARBINARY(MAX)',
    'numeric': 'DECIMAL',
    'double precision': 'FLOAT',
    'real': 'REAL',
    'date': 'DATE',
    'time': 'TIME',
    'interval': 'NVARCHAR(50)',
    'money': 'DECIMAL(19,4)',
    'inet': 'NVARCHAR(45)',
    'cidr': 'NVARCHAR(45)',
    'macaddr': 'NVARCHAR(17)',
    'xml': 'XML',
    'bit': 'BIT',
  },
  'mysql->mssql': {
    'INT AUTO_INCREMENT': 'INT IDENTITY(1,1)',
    'BIGINT AUTO_INCREMENT': 'BIGINT IDENTITY(1,1)',
    'SMALLINT AUTO_INCREMENT': 'SMALLINT IDENTITY(1,1)',
    'TINYINT(1)': 'BIT',
    'LONGTEXT': 'NVARCHAR(MAX)',
    'MEDIUMTEXT': 'NVARCHAR(MAX)',
    'TINYTEXT': 'NVARCHAR(MAX)',
    'DATETIME': 'DATETIME2',
    'TIMESTAMP': 'DATETIME2',
    'JSON': 'NVARCHAR(MAX)',
    'DOUBLE': 'FLOAT',
    'BLOB': 'VARBINARY(MAX)',
    'MEDIUMBLOB': 'VARBINARY(MAX)',
    'LONGBLOB': 'VARBINARY(MAX)',
    'TINYBLOB': 'VARBINARY(MAX)',
    'DECIMAL': 'DECIMAL',
    'FLOAT': 'REAL',
    'YEAR': 'SMALLINT',
    'ENUM': 'NVARCHAR(255)',
    'SET': 'NVARCHAR(MAX)',
    'BIT': 'BIT',
    'BOOLEAN': 'BIT',
    'DATE': 'DATE',
    'TIME': 'TIME',
    'CHAR': 'NCHAR',
    'VARCHAR': 'NVARCHAR',
    'TEXT': 'NVARCHAR(MAX)',
    'INT': 'INT',
    'BIGINT': 'BIGINT',
    'SMALLINT': 'SMALLINT',
    'MEDIUMINT': 'INT',
    'TINYINT': 'TINYINT',
    'NUMERIC': 'DECIMAL',
    'UUID': 'UNIQUEIDENTIFIER',
  },
  'postgresql->clickhouse': {
    'serial': 'UInt32',
    'bigserial': 'UInt64',
    'smallserial': 'UInt16',
    'boolean': 'UInt8',
    'text': 'String',
    'character varying': 'String',
    'character': 'String',
    'timestamp': 'DateTime',
    'timestamptz': 'DateTime',
    'jsonb': 'String',
    'json': 'String',
    'uuid': 'UUID',
    'bytea': 'String',
    'numeric': 'Decimal(38, 10)',
    'double precision': 'Float64',
    'real': 'Float32',
    'date': 'Date',
    'time': 'String',
    'interval': 'String',
    'money': 'Decimal(19, 4)',
    'inet': 'String',
    'cidr': 'String',
    'macaddr': 'String',
    'integer': 'Int32',
    'bigint': 'Int64',
    'smallint': 'Int16',
  },
  'mysql->clickhouse': {
    'INT AUTO_INCREMENT': 'UInt32',
    'BIGINT AUTO_INCREMENT': 'UInt64',
    'SMALLINT AUTO_INCREMENT': 'UInt16',
    'TINYINT(1)': 'UInt8',
    'LONGTEXT': 'String',
    'MEDIUMTEXT': 'String',
    'TINYTEXT': 'String',
    'DATETIME': 'DateTime',
    'TIMESTAMP': 'DateTime',
    'JSON': 'String',
    'DOUBLE': 'Float64',
    'BLOB': 'String',
    'MEDIUMBLOB': 'String',
    'LONGBLOB': 'String',
    'TINYBLOB': 'String',
    'DECIMAL': 'Decimal(38, 10)',
    'FLOAT': 'Float32',
    'YEAR': 'UInt16',
    'ENUM': 'String',
    'SET': 'String',
    'BIT': 'UInt64',
    'BOOLEAN': 'UInt8',
    'DATE': 'Date',
    'TIME': 'String',
    'CHAR': 'String',
    'VARCHAR': 'String',
    'TEXT': 'String',
    'INT': 'Int32',
    'BIGINT': 'Int64',
    'SMALLINT': 'Int16',
    'MEDIUMINT': 'Int32',
    'TINYINT': 'Int8',
    'NUMERIC': 'Decimal(38, 10)',
    'UUID': 'UUID',
  },
  'sqlite->postgresql': {
    'INTEGER': 'INTEGER',
    'REAL': 'DOUBLE PRECISION',
    'TEXT': 'TEXT',
    'BLOB': 'BYTEA',
    'NUMERIC': 'NUMERIC',
    'BOOLEAN': 'BOOLEAN',
    'VARCHAR': 'VARCHAR',
    'DATE': 'DATE',
    'DATETIME': 'TIMESTAMP',
  },
  'sqlite->mysql': {
    'INTEGER': 'INT',
    'REAL': 'DOUBLE',
    'TEXT': 'LONGTEXT',
    'BLOB': 'LONGBLOB',
    'NUMERIC': 'DECIMAL',
    'BOOLEAN': 'TINYINT(1)',
    'VARCHAR': 'VARCHAR',
    'DATE': 'DATE',
    'DATETIME': 'DATETIME',
  },
  'mssql->postgresql': {
    'INT IDENTITY(1,1)': 'SERIAL',
    'BIGINT IDENTITY(1,1)': 'BIGSERIAL',
    'SMALLINT IDENTITY(1,1)': 'SMALLSERIAL',
    'BIT': 'BOOLEAN',
    'NVARCHAR(MAX)': 'TEXT',
    'NTEXT': 'TEXT',
    'DATETIME2': 'TIMESTAMP',
    'DATETIMEOFFSET': 'TIMESTAMPTZ',
    'SMALLDATETIME': 'TIMESTAMP',
    'UNIQUEIDENTIFIER': 'UUID',
    'VARBINARY(MAX)': 'BYTEA',
    'IMAGE': 'BYTEA',
    'NCHAR': 'CHAR',
    'NVARCHAR': 'VARCHAR',
    'FLOAT': 'DOUBLE PRECISION',
    'REAL': 'REAL',
    'DECIMAL': 'NUMERIC',
    'XML': 'TEXT',
    'INT': 'INTEGER',
    'BIGINT': 'BIGINT',
    'SMALLINT': 'SMALLINT',
    'TINYINT': 'SMALLINT',
    'DATE': 'DATE',
    'TIME': 'TIME',
    'DATETIME': 'TIMESTAMP',
    'CHAR': 'CHAR',
    'VARCHAR': 'VARCHAR',
    'TEXT': 'TEXT',
    'NUMERIC': 'NUMERIC',
  },
  'mssql->mysql': {
    'INT IDENTITY(1,1)': 'INT AUTO_INCREMENT',
    'BIGINT IDENTITY(1,1)': 'BIGINT AUTO_INCREMENT',
    'SMALLINT IDENTITY(1,1)': 'SMALLINT AUTO_INCREMENT',
    'BIT': 'TINYINT(1)',
    'NVARCHAR(MAX)': 'LONGTEXT',
    'NTEXT': 'LONGTEXT',
    'DATETIME2': 'DATETIME',
    'DATETIMEOFFSET': 'DATETIME',
    'SMALLDATETIME': 'DATETIME',
    'UNIQUEIDENTIFIER': 'CHAR(36)',
    'VARBINARY(MAX)': 'LONGBLOB',
    'IMAGE': 'LONGBLOB',
    'NCHAR': 'CHAR',
    'NVARCHAR': 'VARCHAR',
    'FLOAT': 'DOUBLE',
    'REAL': 'FLOAT',
    'DECIMAL': 'DECIMAL',
    'XML': 'LONGTEXT',
    'INT': 'INT',
    'BIGINT': 'BIGINT',
    'SMALLINT': 'SMALLINT',
    'TINYINT': 'TINYINT',
    'DATE': 'DATE',
    'TIME': 'TIME',
    'DATETIME': 'DATETIME',
    'CHAR': 'CHAR',
    'VARCHAR': 'VARCHAR',
    'TEXT': 'LONGTEXT',
    'NUMERIC': 'DECIMAL',
  },
  'clickhouse->postgresql': {
    'UInt8': 'SMALLINT',
    'UInt16': 'INTEGER',
    'UInt32': 'BIGINT',
    'UInt64': 'BIGINT',
    'Int8': 'SMALLINT',
    'Int16': 'SMALLINT',
    'Int32': 'INTEGER',
    'Int64': 'BIGINT',
    'Float32': 'REAL',
    'Float64': 'DOUBLE PRECISION',
    'String': 'TEXT',
    'FixedString': 'CHAR',
    'Date': 'DATE',
    'DateTime': 'TIMESTAMP',
    'DateTime64': 'TIMESTAMP',
    'UUID': 'UUID',
    'Array': 'JSONB',
    'Nullable': 'TEXT',
    'JSON': 'JSONB',
    'Decimal': 'NUMERIC',
  },
  'clickhouse->mysql': {
    'UInt8': 'TINYINT UNSIGNED',
    'UInt16': 'SMALLINT UNSIGNED',
    'UInt32': 'INT UNSIGNED',
    'UInt64': 'BIGINT UNSIGNED',
    'Int8': 'TINYINT',
    'Int16': 'SMALLINT',
    'Int32': 'INT',
    'Int64': 'BIGINT',
    'Float32': 'FLOAT',
    'Float64': 'DOUBLE',
    'String': 'LONGTEXT',
    'FixedString': 'CHAR',
    'Date': 'DATE',
    'DateTime': 'DATETIME',
    'DateTime64': 'DATETIME',
    'UUID': 'CHAR(36)',
    'Array': 'JSON',
    'Nullable': 'TEXT',
    'JSON': 'JSON',
    'Decimal': 'DECIMAL',
  },
  'gaussdb->mysql': {
    'serial': 'INT AUTO_INCREMENT',
    'bigserial': 'BIGINT AUTO_INCREMENT',
    'smallserial': 'SMALLINT AUTO_INCREMENT',
    'text': 'LONGTEXT',
    'boolean': 'TINYINT(1)',
    'timestamp': 'DATETIME',
    'timestamptz': 'DATETIME',
    'jsonb': 'JSON',
    'uuid': 'CHAR(36)',
    'bytea': 'LONGBLOB',
    'numeric': 'DECIMAL',
    'double precision': 'DOUBLE',
    'character varying': 'VARCHAR',
    'character': 'CHAR',
    'real': 'FLOAT',
    'time': 'TIME',
    'date': 'DATE',
    'smallint': 'SMALLINT',
    'integer': 'INT',
    'bigint': 'BIGINT',
    'json': 'JSON',
  },
  'mysql->gaussdb': {
    'INT AUTO_INCREMENT': 'SERIAL',
    'BIGINT AUTO_INCREMENT': 'BIGSERIAL',
    'SMALLINT AUTO_INCREMENT': 'SMALLSERIAL',
    'TINYINT(1)': 'BOOLEAN',
    'LONGTEXT': 'TEXT',
    'MEDIUMTEXT': 'TEXT',
    'TINYTEXT': 'TEXT',
    'DATETIME': 'TIMESTAMP',
    'JSON': 'JSONB',
    'DOUBLE': 'DOUBLE PRECISION',
    'BLOB': 'BYTEA',
    'MEDIUMBLOB': 'BYTEA',
    'LONGBLOB': 'BYTEA',
    'TINYBLOB': 'BYTEA',
    'DECIMAL': 'NUMERIC',
    'FLOAT': 'REAL',
    'YEAR': 'SMALLINT',
    'ENUM': 'VARCHAR',
    'SET': 'VARCHAR',
    'BOOLEAN': 'BOOLEAN',
    'DATE': 'DATE',
    'TIME': 'TIME',
    'CHAR': 'CHAR',
    'VARCHAR': 'VARCHAR',
    'TEXT': 'TEXT',
    'INT': 'INTEGER',
    'BIGINT': 'BIGINT',
    'SMALLINT': 'SMALLINT',
    'MEDIUMINT': 'INTEGER',
    'TINYINT': 'SMALLINT',
    'NUMERIC': 'NUMERIC',
  },
  'opengauss->mysql': {
    'serial': 'INT AUTO_INCREMENT',
    'bigserial': 'BIGINT AUTO_INCREMENT',
    'smallserial': 'SMALLINT AUTO_INCREMENT',
    'text': 'LONGTEXT',
    'boolean': 'TINYINT(1)',
    'timestamp': 'DATETIME',
    'timestamptz': 'DATETIME',
    'jsonb': 'JSON',
    'uuid': 'CHAR(36)',
    'bytea': 'LONGBLOB',
    'numeric': 'DECIMAL',
    'double precision': 'DOUBLE',
    'character varying': 'VARCHAR',
    'character': 'CHAR',
    'real': 'FLOAT',
    'time': 'TIME',
    'date': 'DATE',
    'smallint': 'SMALLINT',
    'integer': 'INT',
    'bigint': 'BIGINT',
    'json': 'JSON',
  },
  'mysql->opengauss': {
    'INT AUTO_INCREMENT': 'SERIAL',
    'BIGINT AUTO_INCREMENT': 'BIGSERIAL',
    'SMALLINT AUTO_INCREMENT': 'SMALLSERIAL',
    'TINYINT(1)': 'BOOLEAN',
    'LONGTEXT': 'TEXT',
    'MEDIUMTEXT': 'TEXT',
    'TINYTEXT': 'TEXT',
    'DATETIME': 'TIMESTAMP',
    'JSON': 'JSONB',
    'DOUBLE': 'DOUBLE PRECISION',
    'BLOB': 'BYTEA',
    'MEDIUMBLOB': 'BYTEA',
    'LONGBLOB': 'BYTEA',
    'TINYBLOB': 'BYTEA',
    'DECIMAL': 'NUMERIC',
    'FLOAT': 'REAL',
    'YEAR': 'SMALLINT',
    'ENUM': 'VARCHAR',
    'SET': 'VARCHAR',
    'BOOLEAN': 'BOOLEAN',
    'DATE': 'DATE',
    'TIME': 'TIME',
    'CHAR': 'CHAR',
    'VARCHAR': 'VARCHAR',
    'TEXT': 'TEXT',
    'INT': 'INTEGER',
    'BIGINT': 'BIGINT',
    'SMALLINT': 'SMALLINT',
    'MEDIUMINT': 'INTEGER',
    'TINYINT': 'SMALLINT',
    'NUMERIC': 'NUMERIC',
  },
};

// ===== Helpers =====

function quoteIdentifier(name: string, dbType: string): string {
  switch (dbType) {
    case 'mysql':
      return `\`${name}\``;
    case 'mssql':
      return `[${name}]`;
    default:
      return `"${name}"`;
  }
}

function getMappingKey(sourceType: string, targetType: string): string {
  return `${sourceType}->${targetType}`;
}

/**
 * Map a source data type to a target data type.
 * Falls back to the original type if no mapping is found.
 */
export function mapType(sourceType: string, sourceDb: string, targetDb: string): string {
  if (sourceDb === targetDb) return sourceType;

  const key = getMappingKey(sourceDb, targetDb);
  const mappings = TYPE_MAPPINGS[key];
  if (!mappings) return sourceType;

  // Try exact match first
  const exactMatch = mappings[sourceType];
  if (exactMatch) return exactMatch;

  // Try case-insensitive match
  const upperType = sourceType.toUpperCase();
  for (const [src, tgt] of Object.entries(mappings)) {
    if (src.toUpperCase() === upperType) return tgt;
  }

  // Try matching the base type (without length/precision)
  const baseType = sourceType.replace(/\(.*\)/, '').trim();
  const baseMatch = mappings[baseType];
  if (baseMatch) return baseMatch;

  const upperBase = baseType.toUpperCase();
  for (const [src, tgt] of Object.entries(mappings)) {
    if (src.toUpperCase() === upperBase) return tgt;
  }

  // No mapping found, return original type
  return sourceType;
}

/**
 * Check if a type has unmapped warnings
 */
export function getUnmappedWarnings(
  columns: ColumnDef[],
  sourceDb: string,
  targetDb: string
): string[] {
  if (sourceDb === targetDb) return [];
  const warnings: string[] = [];
  for (const col of columns) {
    const mapped = mapType(col.dataType, sourceDb, targetDb);
    if (mapped === col.dataType) {
      // Check if there's actually a mapping table for this pair
      const key = getMappingKey(sourceDb, targetDb);
      if (TYPE_MAPPINGS[key]) {
        warnings.push(`Column "${col.name}": type "${col.dataType}" may not have an equivalent in ${targetDb}`);
      }
    }
  }
  return warnings;
}

/**
 * Generate DROP TABLE statement for target database
 */
function generateDropTable(tableName: string, schema: string | undefined, dbType: string): string {
  const quoted = schema
    ? `${quoteIdentifier(schema, dbType)}.${quoteIdentifier(tableName, dbType)}`
    : quoteIdentifier(tableName, dbType);
  return `DROP TABLE IF EXISTS ${quoted};`;
}

/**
 * Build a SELECT query for reading data from source with pagination
 */
function buildSelectQuery(
  tableName: string,
  schema: string | undefined,
  dbType: string,
  offset: number,
  limit: number
): string {
  const quoted = schema
    ? `${quoteIdentifier(schema, dbType)}.${quoteIdentifier(tableName, dbType)}`
    : quoteIdentifier(tableName, dbType);

  switch (dbType) {
    case 'mysql':
      return `SELECT * FROM ${quoted} LIMIT ${limit} OFFSET ${offset}`;
    case 'postgresql':
    case 'gaussdb':
      return `SELECT * FROM ${quoted} LIMIT ${limit} OFFSET ${offset}`;
    case 'mssql':
      return `SELECT * FROM ${quoted} ORDER BY (SELECT NULL) OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
    case 'sqlite':
      return `SELECT * FROM ${quoted} LIMIT ${limit} OFFSET ${offset}`;
    case 'clickhouse':
      return `SELECT * FROM ${quoted} LIMIT ${limit} OFFSET ${offset}`;
    default:
      return `SELECT * FROM ${quoted} LIMIT ${limit} OFFSET ${offset}`;
  }
}

/**
 * Build a COUNT query for a table
 */
function buildCountQuery(tableName: string, schema: string | undefined, dbType: string): string {
  const quoted = schema
    ? `${quoteIdentifier(schema, dbType)}.${quoteIdentifier(tableName, dbType)}`
    : quoteIdentifier(tableName, dbType);
  return `SELECT COUNT(*) as cnt FROM ${quoted}`;
}

/**
 * Generate INSERT statement for target database
 */
function buildInsertStatement(
  tableName: string,
  schema: string | undefined,
  dbType: string,
  columns: string[],
  rows: Record<string, any>[]
): string {
  if (rows.length === 0) return '';

  const quoted = schema
    ? `${quoteIdentifier(schema, dbType)}.${quoteIdentifier(tableName, dbType)}`
    : quoteIdentifier(tableName, dbType);

  const quotedCols = columns.map(c => quoteIdentifier(c, dbType));

  const valueRows = rows.map(row => {
    const values = columns.map(col => {
      const val = row[col];
      if (val === null || val === undefined) return 'NULL';
      if (typeof val === 'number') return String(val);
      if (typeof val === 'boolean') return val ? '1' : '0';
      // Escape single quotes
      const escaped = String(val).replace(/'/g, "''");
      return `'${escaped}'`;
    });
    return `(${values.join(', ')})`;
  });

  return `INSERT INTO ${quoted} (${quotedCols.join(', ')}) VALUES\n${valueRows.join(',\n')};`;
}

/**
 * Get estimated row count for a table
 */
export async function getTableRowCount(
  connectionId: string,
  tableName: string,
  schema: string | undefined,
  dbType: string
): Promise<number> {
  try {
    const sql = buildCountQuery(tableName, schema, dbType);
    const result = await executeQuery(connectionId, sql);
    if (result.rows.length > 0) {
      const cnt = result.rows[0]!['cnt'] ?? result.rows[0]!['COUNT(*)'] ?? 0;
      return Number(cnt) || 0;
    }
  } catch {
    // Ignore count errors
  }
  return 0;
}

/**
 * Load tables from a connection
 */
export async function loadSourceTables(
  connectionId: string,
  schema?: string
): Promise<TableMigrationInfo[]> {
  const tables = await getTables(connectionId);
  return tables
    .filter(() => true)
    .filter(t => !schema || t.schema === schema)
    .map(t => ({
      name: t.name,
      schema: t.schema,
      rowCount: undefined,
      selected: false,
    }));
}

/**
 * Generate DDL for a table migration
 */
export async function generateMigrationDDL(
  config: MigrationConfig,
  sourceConnection: Connection,
  targetConnection: Connection,
  tableName: string,
  tableSchema?: string
): Promise<{ ddl: string; warnings: string[] }> {
  // Get column info from source
  const columns = await getColumns(config.sourceConnectionId, tableName, tableSchema);

  // Build ColumnDef array with type mapping
  const mappedColumns: ColumnDef[] = columns.map(col => {
    const mappedType = mapType(col.type, sourceConnection.type, targetConnection.type);
    return {
      name: col.name,
      dataType: mappedType,
      nullable: !col.notNull,
      primaryKey: col.primaryKey,
      autoIncrement: false, // Will be handled by type mapping
      unique: col.unique,
    };
  });

  // Check if the original type implies auto-increment
  const sourceTypeLower = sourceConnection.type.toLowerCase();
  for (const col of columns) {
    const typeLower = col.type.toLowerCase();
    if (
      (sourceTypeLower === 'mysql' && typeLower.includes('auto_increment')) ||
      (sourceTypeLower === 'postgresql' && (typeLower === 'serial' || typeLower === 'bigserial' || typeLower === 'smallserial')) ||
      (sourceTypeLower === 'gaussdb' && (typeLower === 'serial' || typeLower === 'bigserial' || typeLower === 'smallserial')) ||
      (sourceTypeLower === 'opengauss' && (typeLower === 'serial' || typeLower === 'bigserial' || typeLower === 'smallserial'))
    ) {
      const mapped = mappedColumns.find(c => c.name === col.name);
      if (mapped) mapped.autoIncrement = true;
    }
  }

  // Build TableDef
  const tableDef: TableDef = {
    name: tableName,
    schema: config.targetSchema || tableSchema,
    columns: mappedColumns,
  };

  // Generate DDL
  let ddl = '';
  if (config.dropExisting) {
    ddl += generateDropTable(tableName, config.targetSchema || tableSchema, targetConnection.type);
    ddl += '\n';
  }
  ddl += generateCreateTable(tableDef, targetConnection.type);

  // Get warnings
  const warnings = getUnmappedWarnings(mappedColumns, sourceConnection.type, targetConnection.type);

  return { ddl, warnings };
}

/**
 * Generate all DDL statements for preview
 */
export async function generateAllDDL(
  config: MigrationConfig,
  sourceConnection: Connection,
  targetConnection: Connection,
  tables: TableMigrationInfo[]
): Promise<{ ddls: Map<string, string>; warnings: string[] }> {
  const ddls = new Map<string, string>();
  const allWarnings: string[] = [];

  for (const table of tables) {
    if (!table.selected) continue;
    try {
      const { ddl, warnings } = await generateMigrationDDL(
        config,
        sourceConnection,
        targetConnection,
        table.name,
        table.schema
      );
      ddls.set(table.name, ddl);
      allWarnings.push(...warnings);
    } catch (err) {
      allWarnings.push(`Error generating DDL for ${table.name}: ${err}`);
    }
  }

  return { ddls, warnings: allWarnings };
}

/**
 * Main migration function
 */
export async function migrateData(
  config: MigrationConfig,
  sourceConnection: Connection,
  targetConnection: Connection,
  onProgress: (progress: MigrationProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const progress: MigrationProgress = {
    currentTable: '',
    currentStep: 'idle',
    tablesCompleted: 0,
    totalTables: config.tables.length,
    rowsCopied: 0,
    totalRows: 0,
    errors: [],
    logs: [],
    startTime: Date.now(),
    cancelled: false,
  };

  const log = (msg: string) => {
    progress.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    onProgress({ ...progress });
  };

  const checkCancelled = () => {
    if (signal?.aborted) {
      progress.cancelled = true;
      progress.logs.push('Migration cancelled by user.');
      onProgress({ ...progress });
      throw new Error('Migration cancelled');
    }
  };

  log(`Starting migration: ${sourceConnection.name} (${sourceConnection.type}) -> ${targetConnection.name} (${targetConnection.type})`);
  log(`Mode: ${config.mode}, Tables: ${config.tables.length}, Batch size: ${config.batchSize}`);

  try {
    const parameterized = await supportsBulkWrite(config.targetConnectionId);
    for (let i = 0; i < config.tables.length; i++) {
      checkCancelled();

      const tableName = config.tables[i]!;
      const tableSchema = config.sourceSchema;
      progress.currentTable = tableName;

      // Find schema from table info if available
      log(`Processing table: ${tableName}${tableSchema ? ` (${tableSchema})` : ''}`);

      // Step 1: Get columns from source
      progress.currentStep = 'creating';
      onProgress({ ...progress });

      let columns: ColumnInfo[];
      try {
        columns = await getColumns(config.sourceConnectionId, tableName, tableSchema);
      } catch (err) {
        const msg = `Failed to get columns for ${tableName}: ${err}`;
        progress.errors.push(msg);
        log(msg);
        if (config.stopOnError) {
          progress.currentStep = 'done';
          onProgress({ ...progress });
          return;
        }
        progress.tablesCompleted++;
        onProgress({ ...progress });
        continue;
      }

      // Step 2: Generate DDL for target
      const mappedColumns: ColumnDef[] = columns.map(col => {
        const mappedType = mapType(col.type, sourceConnection.type, targetConnection.type);
        return {
          name: col.name,
          dataType: mappedType,
          nullable: !col.notNull,
          primaryKey: col.primaryKey,
          autoIncrement: false, // Will be handled by type mapping
          unique: col.unique,
        };
      });

      // Handle auto-increment detection
      const sourceTypeLower = sourceConnection.type.toLowerCase();
      for (const col of columns) {
        const typeLower = col.type.toLowerCase();
        if (
          (sourceTypeLower === 'mysql' && typeLower.includes('auto_increment')) ||
          (sourceTypeLower === 'postgresql' && (typeLower === 'serial' || typeLower === 'bigserial' || typeLower === 'smallserial')) ||
          (sourceTypeLower === 'gaussdb' && (typeLower === 'serial' || typeLower === 'bigserial' || typeLower === 'smallserial'))
        ) {
          const mapped = mappedColumns.find(c => c.name === col.name);
          if (mapped) mapped.autoIncrement = true;
        }
      }

      // Step 3: Execute DDL on target (if mode includes structure)
      if (config.mode === 'structure' || config.mode === 'both') {
        const tableDef: TableDef = {
          name: tableName,
          schema: config.targetSchema || tableSchema,
          columns: mappedColumns,
        };

        let ddl = '';
        if (config.dropExisting) {
          ddl = generateDropTable(tableName, config.targetSchema || tableSchema, targetConnection.type);
        }
        ddl += generateCreateTable(tableDef, targetConnection.type);

        try {
          await executeSql(config.targetConnectionId, ddl);
          log(`Created table: ${tableName}`);
        } catch (err) {
          const msg = `Failed to create table ${tableName}: ${err}`;
          progress.errors.push(msg);
          log(msg);
          if (config.stopOnError) {
            progress.currentStep = 'done';
            onProgress({ ...progress });
            return;
          }
          progress.tablesCompleted++;
          onProgress({ ...progress });
          continue;
        }
      }

      // Step 4: Copy data (if mode includes data)
      if (config.mode === 'data' || config.mode === 'both') {
        progress.currentStep = 'copying';
        onProgress({ ...progress });

        // Get row count
        let totalRows = 0;
        try {
          totalRows = await getTableRowCount(
            config.sourceConnectionId,
            tableName,
            tableSchema,
            sourceConnection.type
          );
        } catch {
          // If count fails, we'll still try to copy
        }

        progress.totalRows += totalRows;
        log(`Copying ${totalRows} rows from ${tableName}`);

        const columnNames = columns.map(c => c.name);
        let offset = 0;
        let tableRowsCopied = 0;

        while (true) {
          checkCancelled();

          try {
            const selectSql = buildSelectQuery(
              tableName,
              tableSchema,
              sourceConnection.type,
              offset,
              config.batchSize
            );
            const result = await executeQuery(config.sourceConnectionId, selectSql);

            if (!result.rows || result.rows.length === 0) break;

            // Generate INSERT for target
            const insertSql = parameterized ? "" : buildInsertStatement(
              tableName,
              config.targetSchema || tableSchema,
              targetConnection.type,
              columnNames,
              result.rows
            );

            if (parameterized) {
              await insertRowsBulk({ id: config.targetConnectionId, table: tableName,
                schema: config.targetSchema || tableSchema, columns: columnNames },
                result.rows.map(row => columnNames.map(column => row[column] ?? null)), true);
            } else if (insertSql) {
              await executeSql(config.targetConnectionId, insertSql);
            }

            tableRowsCopied += result.rows.length;
            progress.rowsCopied += result.rows.length;
            offset += config.batchSize;

            onProgress({ ...progress });

            if (result.rows.length < config.batchSize) break;
          } catch (err) {
            const msg = `Error copying data for ${tableName} at offset ${offset}: ${err}`;
            progress.errors.push(msg);
            log(msg);
            if (config.stopOnError) {
              progress.currentStep = 'done';
              onProgress({ ...progress });
              return;
            }
            break;
          }
        }

        log(`Copied ${tableRowsCopied} rows for table ${tableName}`);
      }

      progress.tablesCompleted++;
      log(`Completed table: ${tableName} (${progress.tablesCompleted}/${progress.totalTables})`);
      onProgress({ ...progress });
    }

    progress.currentStep = 'done';
    progress.currentTable = '';
    const elapsed = ((Date.now() - progress.startTime) / 1000).toFixed(1);
    log(`Migration completed in ${elapsed}s. Tables: ${progress.tablesCompleted}, Rows: ${progress.rowsCopied}, Errors: ${progress.errors.length}`);
    onProgress({ ...progress });
  } catch (err) {
    if (progress.cancelled) return;
    const msg = `Migration failed: ${err}`;
    progress.errors.push(msg);
    log(msg);
    progress.currentStep = 'done';
    onProgress({ ...progress });
  }
}
