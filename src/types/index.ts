// Database types
export interface ConnectionConfig {
  id: string;
  name: string;
  type: string; // built-in: postgresql|mysql|sqlite|mssql|clickhouse|gaussdb|opengauss, plugin: plugin:<id>
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  filePath?: string;
  enableSsl?: boolean;
  sslCerts?: {
    caCert?: string;
    clientCert?: string;
    clientKey?: string;
  };
  sshTunnel?: {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
  };
  keepaliveInterval?: number;
  autoReconnect?: boolean;
}

export interface Connection extends ConnectionConfig {
  connected: boolean;
  lastConnected?: Date;
  health?: ConnectionHealth;
}

export interface ConnectionGroup {
  id: string;
  name: string;
  parentId?: string;
  sortOrder?: number;
  createdAt?: string;
}

export interface ConnectionHealth {
  status: 'healthy' | 'unhealthy';
  lastChecked: Date;
  error?: string;
}

export interface QueryResult {
  columns: ColumnInfo[];
  rows: any[];
  rowCount: number;
  duration: number;
  error?: string;
}

export interface PagedQueryResult extends QueryResult {
  hasMore: boolean;
}

export interface ExecuteResult {
  success: boolean;
  message: string;
  duration: number;
  error?: string;
}

export interface TableInfo {
  oid: number | null;
  name: string;
  schema: string;
  owner: string | null;
  size: string;
  description: string;
  acl: string | null;
  tablespace: string;
  hasIndexes: boolean | null;
  hasRules: boolean;
  hasTriggers: boolean | null;
  rowCount: number | null;
  primaryKey: string | null;
  partitionOf: string | null;
  tableType: string;
  created: Date;
  modified: Date;
  // MySQL-specific fields
  engine: string | null;
  dataLength: number | null;
  createTime: string | null;
  updateTime: string | null;
  collation: string | null;
}

export interface ColumnInfo {
  name: string;
  type: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  notNull: boolean;
  defaultValue: any;
  description: string;
  primaryKey: boolean;
  unique: boolean;
}

export interface SchemaNode {
  id: string;
  name: string;
  type: 'schema' | 'table' | 'view' | 'materialized_view' | 'function' | 'role'
      | 'tables' | 'views' | 'functions' | 'procedures' | 'triggers' | 'database';
  parentId?: string;
  children?: SchemaNode[];
  schemaName?: string;
  connectionId?: string;
  loaded?: boolean;
}

export interface SelectedContext {
  type: "connection" | "schema" | "folder" | "table";
  connectionId: string;
  schemaName?: string;
  folderType?: string;
  tableName?: string;
}

export interface Tab {
  id: string;
  type: 'query' | 'table' | 'er' | 'designer' | 'diff' | 'migration' | 'analyzer' | 'notebook' | 'query-builder';
  title: string;
  titleKey?: string;
  titleNum?: number;
  content?: string;
  connectionId?: string;
  databaseName?: string;
  tableName?: string;
  schemaName?: string;
  queryResult?: QueryResult;
  isExecuting?: boolean;
  messages?: string[];
  activeResultTab?: 'results' | 'messages' | 'executionPlan';
  executionPlan?: any[];
  cells?: any[];
  activeCellId?: string;
}

export interface QueryHistoryEntry {
  id: string;
  connectionId: string;
  sql: string;
  timestamp: Date;
  duration: number;
  rowCount: number;
  error?: string;
}

export interface SlowQueryEntry {
  id: string;
  connectionId: string;
  sql: string;
  timestamp: Date;
  duration: number;
  rowCount: number;
}

export interface ThemeConfig {
  mode: 'light' | 'dark';
  accentColor: string;
  fontFamily: string;
}

export interface UIState {
  theme: ThemeConfig;
  language: 'zh' | 'en';
  aiPanelOpen: boolean;
  resultPanelOpen: boolean;
  activeNavicatTab: string;
  selectedSchemaId: string | null;
  selectedSchemaName: string | null;
  selectedTableId: string | null;
  selectedTable: TableInfo | null;
  selectedTableData: QueryResult | null;
  selectedTableDDL: string | null;
  schemaData: Record<string, SchemaNode[]>;
}

export interface ConnectionState {
  connections: Connection[];
  activeConnectionId: string | null;
  connectionHealth: Record<string, ConnectionHealth>;
}

export interface TabState {
  tabs: Tab[];
  activeTabId: string | null;
  isExecuting: boolean;
  queryResults: Record<string, QueryResult>;
}

export interface HistoryState {
  queryHistory: QueryHistoryEntry[];
  slowQueries: SlowQueryEntry[];
  slowQueryThreshold: number;
}
