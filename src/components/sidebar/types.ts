// Shared types for Sidebar and its sub-components.

export type SidebarView = "connections" | "history";

export type TreeNodeType =
  | "connection"
  | "database"
  | "schema"
  | "tables"
  | "views"
  | "functions"
  | "procedures"
  | "events"
  | "triggers"
  | "table"
  | "view"
  | "function"
  | "procedure"
  | "event"
  | "trigger";

export interface TreeNode {
  id: string;
  name: string;
  type: TreeNodeType;
  connectionId?: string;
  databaseName?: string;
  schemaName?: string;
  loaded?: boolean;
  children?: TreeNode[];
}
