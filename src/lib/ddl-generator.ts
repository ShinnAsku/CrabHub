export interface ColumnDef {
  name: string;
  dataType: string;
  length?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue?: string;
  comment?: string;
  unique?: boolean;
}

export interface TableDef {
  name: string;
  schema?: string;
  columns: ColumnDef[];
  comment?: string;
  engine?: string;    // for MySQL/ClickHouse
  charset?: string;   // for MySQL
  orderBy?: string;   // for ClickHouse ORDER BY
}

// ===== Helpers =====

function quote(name: string, dbType: string): string {
  switch (dbType) {
    case 'mysql':
      return `\`${name}\``;
    case 'mssql':
      return `[${name}]`;
    default:
      return `"${name}"`;
  }
}

function buildColumnType(col: ColumnDef, _dbType: string): string {
  let type = col.dataType;
  if (col.length && col.length > 0) {
    type += `(${col.length})`;
  } else if (col.precision !== undefined && col.precision !== null) {
    if (col.scale !== undefined && col.scale !== null && col.scale > 0) {
      type += `(${col.precision}, ${col.scale})`;
    } else {
      type += `(${col.precision})`;
    }
  }
  return type;
}

function buildColumnConstraints(col: ColumnDef, dbType: string): string[] {
  const parts: string[] = [];

  if (!col.nullable) {
    parts.push('NOT NULL');
  }

  if (col.autoIncrement) {
    switch (dbType) {
      case 'mysql':
        parts.push('AUTO_INCREMENT');
        break;
      case 'mssql':
        parts.push('IDENTITY(1,1)');
        break;
      case 'postgresql':
      case 'gaussdb':
      case 'opengauss':
        // serial/bigserial handle this implicitly; for integer types we add GENERATED ALWAYS AS IDENTITY
        if (col.dataType !== 'serial' && col.dataType !== 'bigserial' && col.dataType !== 'smallserial') {
          parts.push('GENERATED ALWAYS AS IDENTITY');
        }
        break;
    }
  }

  if (col.defaultValue !== undefined && col.defaultValue !== '') {
    const upperDefault = col.defaultValue.toUpperCase();
    if (
      upperDefault === 'NULL' ||
      upperDefault === 'CURRENT_TIMESTAMP' ||
      upperDefault === 'CURRENT_DATE' ||
      upperDefault === 'CURRENT_TIME' ||
      upperDefault === 'NOW()' ||
      upperDefault.startsWith('NEXTVAL(') ||
      upperDefault === 'UUID_GENERATE_V4()' ||
      upperDefault === 'NEWID()' ||
      upperDefault === 'GEN_RANDOM_UUID()'
    ) {
      parts.push(`DEFAULT ${col.defaultValue}`);
    } else {
      parts.push(`DEFAULT '${col.defaultValue.replace(/'/g, "''")}'`);
    }
  }

  if (col.unique) {
    parts.push('UNIQUE');
  }

  return parts;
}

function buildColumnComment(col: ColumnDef, dbType: string): string {
  if (!col.comment) return '';
  switch (dbType) {
    case 'mysql':
      return ` COMMENT '${col.comment.replace(/'/g, "''")}'`;
    default:
      return '';
  }
}

// ===== PostgreSQL / GaussDB =====

function generatePgCreateTable(def: TableDef): string {
  const lines: string[] = [];
  const pkCols: string[] = [];

  for (const col of def.columns) {
    const colName = quote(col.name, 'postgresql');
    const colType = buildColumnType(col, 'postgresql');
    const constraints = buildColumnConstraints(col, 'postgresql');
    const parts = [colName, colType, ...constraints];
    lines.push('  ' + parts.join(' '));

    if (col.primaryKey) {
      pkCols.push(colName);
    }
  }

  if (pkCols.length > 0) {
    lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
  }

  const schema = def.schema ? `${quote(def.schema, 'postgresql')}.` : '';
  let sql = `CREATE TABLE ${schema}${quote(def.name, 'postgresql')} (\n${lines.join(',\n')}\n);`;

  if (def.comment) {
    sql += `\nCOMMENT ON TABLE ${schema}${quote(def.name, 'postgresql')} IS '${def.comment.replace(/'/g, "''")}';`;
  }

  for (const col of def.columns) {
    if (col.comment) {
      sql += `\nCOMMENT ON COLUMN ${schema}${quote(def.name, 'postgresql')}.${quote(col.name, 'postgresql')} IS '${col.comment.replace(/'/g, "''")}';`;
    }
  }

  return sql;
}

// ===== MySQL =====

function generateMySqlCreateTable(def: TableDef): string {
  const lines: string[] = [];
  const pkCols: string[] = [];

  for (const col of def.columns) {
    const colName = quote(col.name, 'mysql');
    const colType = buildColumnType(col, 'mysql');
    const constraints = buildColumnConstraints(col, 'mysql');
    const comment = buildColumnComment(col, 'mysql');
    const parts = [colName, colType, ...constraints];
    if (comment) parts.push(comment);
    lines.push('  ' + parts.join(' '));

    if (col.primaryKey) {
      pkCols.push(colName);
    }
  }

  if (pkCols.length > 0) {
    lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
  }

  const options: string[] = [];
  if (def.engine) {
    options.push(`ENGINE=${def.engine}`);
  }
  if (def.charset) {
    options.push(`DEFAULT CHARSET=${def.charset}`);
  }

  let sql = `CREATE TABLE ${quote(def.name, 'mysql')} (\n${lines.join(',\n')}\n)`;
  if (options.length > 0) {
    sql += ' ' + options.join(' ');
  }
  sql += ';';

  if (def.comment) {
    sql += `\nALTER TABLE ${quote(def.name, 'mysql')} COMMENT='${def.comment.replace(/'/g, "''")}';`;
  }

  return sql;
}

// ===== SQLite =====

function generateSqliteCreateTable(def: TableDef): string {
  const lines: string[] = [];
  const pkCols: string[] = [];

  for (const col of def.columns) {
    const colName = quote(col.name, 'sqlite');
    const colType = buildColumnType(col, 'sqlite');
    const constraints = buildColumnConstraints(col, 'sqlite');
    const parts = [colName, colType, ...constraints];
    lines.push('  ' + parts.join(' '));

    if (col.primaryKey) {
      pkCols.push(colName);
    }
  }

  if (pkCols.length > 0) {
    lines.push(`  PRIMARY KEY (${pkCols.join(', ')})`);
  }

  return `CREATE TABLE ${quote(def.name, 'sqlite')} (\n${lines.join(',\n')}\n);`;
}

// ===== ClickHouse =====

function generateClickHouseCreateTable(def: TableDef): string {
  const lines: string[] = [];

  for (const col of def.columns) {
    const colName = quote(col.name, 'clickhouse');
    const colType = buildColumnType(col, 'clickhouse');
    const constraints = buildColumnConstraints(col, 'clickhouse');
    const parts = [colName, colType, ...constraints];
    lines.push('  ' + parts.join(' '));
  }

  const options: string[] = [];
  if (def.engine) {
    options.push(`ENGINE = ${def.engine}`);
  } else {
    options.push('ENGINE = MergeTree()');
  }

  if (def.orderBy) {
    options.push(`ORDER BY (${def.orderBy})`);
  } else {
    // Default to first column or tuple()
    const firstCol = def.columns[0];
    if (firstCol) {
      options.push(`ORDER BY (${quote(firstCol.name, 'clickhouse')})`);
    } else {
      options.push('ORDER BY tuple()');
    }
  }

  let sql = `CREATE TABLE ${quote(def.name, 'clickhouse')} (\n${lines.join(',\n')}\n)\n${options.join('\n')};`;

  if (def.comment) {
    sql += `\nCOMMENT ON TABLE ${quote(def.name, 'clickhouse')} IS '${def.comment.replace(/'/g, "''")}';`;
  }

  return sql;
}

// ===== MSSQL =====

function generateMssqlCreateTable(def: TableDef): string {
  const lines: string[] = [];
  const pkCols: string[] = [];

  for (const col of def.columns) {
    const colName = quote(col.name, 'mssql');
    const colType = buildColumnType(col, 'mssql');
    const constraints = buildColumnConstraints(col, 'mssql');
    const parts = [colName, colType, ...constraints];
    lines.push('    ' + parts.join(' '));

    if (col.primaryKey) {
      pkCols.push(colName);
    }
  }

  if (pkCols.length > 0) {
    lines.push(`    PRIMARY KEY (${pkCols.join(', ')})`);
  }

  const schema = def.schema ? `${quote(def.schema, 'mssql')}.` : '';
  let sql = `CREATE TABLE ${schema}${quote(def.name, 'mssql')} (\n${lines.join(',\n')}\n);`;

  return sql;
}

// ===== Main Generator =====

export function generateCreateTable(def: TableDef, dbType: string): string {
  switch (dbType) {
    case 'postgresql':
    case 'gaussdb':
      return generatePgCreateTable(def);
    case 'mysql':
      return generateMySqlCreateTable(def);
    case 'sqlite':
      return generateSqliteCreateTable(def);
    case 'clickhouse':
      return generateClickHouseCreateTable(def);
    case 'mssql':
      return generateMssqlCreateTable(def);
    default:
      return generatePgCreateTable(def);
  }
}

// ===== ALTER TABLE Generator (for editing existing tables) =====

export interface AlterColumnChange {
  type: 'add' | 'drop' | 'modify' | 'rename';
  column?: ColumnDef;
  oldName?: string;
}

export function generateAlterTable(
  tableName: string,
  schema: string | undefined,
  changes: AlterColumnChange[],
  dbType: string
): string {
  if (changes.length === 0) return '';

  const schemaPrefix = schema ? `${quote(schema, dbType)}.` : '';
  const fullTableName = `${schemaPrefix}${quote(tableName, dbType)}`;

  // For PostgreSQL/GaussDB, each ALTER COLUMN clause must be a separate statement
  const isPg = dbType === 'postgresql' || dbType === 'gaussdb' || dbType === 'opengauss';

  if (isPg) {
    const statements: string[] = [];
    const simpleLines: string[] = []; // ADD/DROP can be combined

    for (const change of changes) {
      switch (change.type) {
        case 'add': {
          if (!change.column) break;
          const colName = quote(change.column.name, dbType);
          const colType = buildColumnType(change.column, dbType);
          const constraints = buildColumnConstraints(change.column, dbType);
          const parts = [colName, colType, ...constraints];
          simpleLines.push(`  ADD COLUMN ${parts.join(' ')}`);
          break;
        }
        case 'drop': {
          if (!change.oldName) break;
          simpleLines.push(`  DROP COLUMN ${quote(change.oldName, dbType)}`);
          break;
        }
        case 'modify': {
          if (!change.column) break;
          const colName = quote(change.column.name, dbType);
          const colType = buildColumnType(change.column, dbType);
          // Each ALTER COLUMN sub-clause needs its own ALTER TABLE statement
          statements.push(`ALTER TABLE ${fullTableName}\n  ALTER COLUMN ${colName} TYPE ${colType};`);
          if (!change.column.nullable) {
            statements.push(`ALTER TABLE ${fullTableName}\n  ALTER COLUMN ${colName} SET NOT NULL;`);
          } else {
            statements.push(`ALTER TABLE ${fullTableName}\n  ALTER COLUMN ${colName} DROP NOT NULL;`);
          }
          if (change.column.defaultValue !== undefined && change.column.defaultValue !== '') {
            statements.push(`ALTER TABLE ${fullTableName}\n  ALTER COLUMN ${colName} SET DEFAULT ${change.column.defaultValue};`);
          }
          // Handle column comment
          if (change.column.comment) {
            const escapedComment = change.column.comment.replace(/'/g, "''");
            statements.push(`COMMENT ON COLUMN ${fullTableName}.${colName} IS '${escapedComment}';`);
          }
          break;
        }
        case 'rename': {
          if (!change.oldName || !change.column) break;
          statements.push(`ALTER TABLE ${fullTableName}\n  RENAME COLUMN ${quote(change.oldName, dbType)} TO ${quote(change.column.name, dbType)};`);
          break;
        }
      }
    }

    // Combine ADD/DROP lines into one ALTER TABLE, then append modify statements
    const result: string[] = [];
    if (simpleLines.length > 0) {
      result.push(`ALTER TABLE ${fullTableName}\n${simpleLines.join(',\n')};`);
    }
    result.push(...statements);
    return result.join('\n\n');
  }

  // SQLite: each ALTER must be its own statement; MODIFY/DROP not supported
  if (dbType === 'sqlite') {
    const statements: string[] = [];
    for (const change of changes) {
      switch (change.type) {
        case 'add': {
          if (!change.column) break;
          const colName = quote(change.column.name, dbType);
          const colType = buildColumnType(change.column, dbType);
          const constraints = buildColumnConstraints(change.column, dbType);
          statements.push(`ALTER TABLE ${fullTableName} ADD COLUMN ${[colName, colType, ...constraints].join(' ')};`);
          break;
        }
        case 'rename': {
          if (!change.oldName || !change.column) break;
          statements.push(`ALTER TABLE ${fullTableName} RENAME COLUMN ${quote(change.oldName, dbType)} TO ${quote(change.column.name, dbType)};`);
          break;
        }
        case 'modify':
        case 'drop': {
          statements.push(`-- SQLite does not support ${change.type === 'modify' ? 'MODIFY' : 'DROP'} COLUMN directly.`);
          if (change.oldName) {
            statements.push(`-- Column '${change.oldName}' requires manual migration (recreate table).`);
          }
          break;
        }
      }
    }
    return statements.join('\n');
  }

  // For other databases (MySQL, ClickHouse, etc.) - single ALTER TABLE with comma-separated clauses
  const lines: string[] = [];

  for (const change of changes) {
    switch (change.type) {
      case 'add': {
        if (!change.column) break;
        const colName = quote(change.column.name, dbType);
        const colType = buildColumnType(change.column, dbType);
        const constraints = buildColumnConstraints(change.column, dbType);
        const comment = dbType === 'mysql' ? buildColumnComment(change.column, dbType) : '';
        const parts = [colName, colType, ...constraints];
        if (comment) parts.push(comment);
        lines.push(`  ADD COLUMN ${parts.join(' ')}`);
        break;
      }
      case 'drop': {
        if (!change.oldName) break;
        lines.push(`  DROP COLUMN ${quote(change.oldName, dbType)}`);
        break;
      }
      case 'modify': {
        if (!change.column) break;
        const colName = quote(change.column.name, dbType);
        const colType = buildColumnType(change.column, dbType);
        const constraints = buildColumnConstraints(change.column, dbType);
        const comment = dbType === 'mysql' ? buildColumnComment(change.column, dbType) : '';
        const parts = [colName, colType, ...constraints];
        if (comment) parts.push(comment);

        switch (dbType) {
          case 'mysql':
            lines.push(`  MODIFY COLUMN ${parts.join(' ')}`);
            break;
          case 'mssql':
            lines.push(`  ALTER COLUMN ${colName} ${colType}`);
            break;
          default:
            lines.push(`  ALTER COLUMN ${parts.join(' ')}`);
        }
        break;
      }
      case 'rename': {
        if (!change.oldName || !change.column) break;
        switch (dbType) {
          case 'mysql':
            lines.push(`  RENAME COLUMN ${quote(change.oldName, dbType)} TO ${quote(change.column.name, dbType)}`);
            break;
          case 'mssql':
            lines.push(`  EXEC sp_rename '${tableName}.${change.oldName}', '${change.column.name}', 'COLUMN'`);
            break;
          default:
            lines.push(`  RENAME COLUMN ${quote(change.oldName, dbType)} TO ${quote(change.column.name, dbType)}`);
        }
        break;
      }
    }
  }

  if (lines.length === 0) return '';
  return `ALTER TABLE ${fullTableName}\n${lines.join(',\n')};`;
}
