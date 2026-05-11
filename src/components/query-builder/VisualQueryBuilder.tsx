import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import ReactFlow, {
  ReactFlowProvider,
  addEdge,
  useNodesState,
  useEdgesState,
  Controls,
  Background,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  Connection,
  Edge,
  Node,
  Panel,
  NodeProps,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  Play,
  Save,
  X,
  Table,
  Columns,
  Filter,
  GitMerge,
  Eye,
  Settings,
  Plus,
  Trash2,
  Database,
} from "lucide-react";
import { t } from "@/lib/i18n";
import { useAppStore } from "@/stores/app-store";
import { getTables, getColumns } from "@/lib/tauri-commands";

interface TableInfo {
  name: string;
  schema?: string;
  columns: ColumnInfo[];
}

interface ColumnInfo {
  name: string;
  type: string;
}

interface Filter {
  id: string;
  column: string;
  operator: string;
  value: string;
}

interface QueryBuilderProps {
  connectionId: string;
  onClose: () => void;
  onQueryGenerated: (sql: string) => void;
}

// Custom Table Node Component
const TableNode = ({ data, selected }: NodeProps<{ label: string; columns: ColumnInfo[]; selectedColumns: string[]; onSelectColumn: (col: string) => void; onRemove: () => void }>) => {
  return (
    <div className={`border-2 rounded-lg shadow-lg bg-card min-w-[220px] ${selected ? "border-[hsl(var(--tab-active))]" : "border-border"}`}>
      <Handle type="target" position={Position.Left} className="w-3 h-3 bg-blue-500" />
      <div className="p-2 bg-muted border-b border-border flex items-center justify-between rounded-t-lg">
        <div className="flex items-center gap-2">
          <Table size={16} className="text-[hsl(var(--tab-active))]" />
          <span className="font-medium text-sm">{data.label}</span>
        </div>
        <button onClick={data.onRemove} className="p-1 rounded hover:bg-accent">
          <X size={12} />
        </button>
      </div>
      <div className="p-2 max-h-[200px] overflow-y-auto">
        {data.columns.map((col) => (
          <div
            key={col.name}
            className={`py-1 px-2 my-1 rounded flex items-center justify-between cursor-pointer text-sm ${
              data.selectedColumns.includes(`${data.label}.${col.name}`) 
                ? "bg-[hsl(var(--tab-active))] text-white" 
                : "hover:bg-muted"
            }`}
            onClick={() => data.onSelectColumn(`${data.label}.${col.name}`)}
          >
            <span className="truncate">{col.name}</span>
            <span className="text-xs text-muted-foreground ml-2">{col.type}</span>
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Right} className="w-3 h-3 bg-blue-500" />
    </div>
  );
};

// Custom Join Edge Component
import type { EdgeProps } from 'reactflow';

const JoinEdge = ({ data, selected }: EdgeProps<{ type: string; condition: string }>) => {
  return (
    <div className={`px-2 py-1 bg-card border border-border rounded text-xs ${selected ? "border-[hsl(var(--tab-active))]" : ""}`}>
      {data?.type || "JOIN"}
    </div>
  );
};

const nodeTypes = {
  table: TableNode,
};

const edgeTypes = {
  join: JoinEdge,
};

const VisualQueryBuilder: React.FC<QueryBuilderProps> = ({ 
  connectionId, 
  onClose, 
  onQueryGenerated 
}) => {
  const [availableTables, setAvailableTables] = useState<TableInfo[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedColumns, setSelectedColumns] = useState<string[]>([]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [limit, setLimit] = useState<string>("100");
  const [loading, setLoading] = useState(true);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<any>(null);
  
  const { activeConnectionId } = useAppStore();
  const effectiveConnectionId = connectionId || activeConnectionId;

  // Load tables on component mount
  useEffect(() => {
    if (!effectiveConnectionId) return;

    const loadTables = async () => {
      try {
        setLoading(true);
        const tables = await getTables(effectiveConnectionId);
        const tablesWithColumns: TableInfo[] = await Promise.all(
          tables.map(async (table: any) => {
            const columns = await getColumns(effectiveConnectionId, table.name, table.schema);
            return {
              name: table.name,
              schema: table.schema,
              columns: columns.map((col: any) => ({
                name: col.name,
                type: col.type,
              })),
            };
          })
        );
        setAvailableTables(tablesWithColumns);
      } catch (err) {
        console.error("Failed to load tables:", err);
        // Use mock data for demo
        setAvailableTables([
          {
            name: "users",
            columns: [
              { name: "id", type: "int" },
              { name: "name", type: "varchar" },
              { name: "email", type: "varchar" },
              { name: "created_at", type: "timestamp" },
            ],
          },
          {
            name: "orders",
            columns: [
              { name: "id", type: "int" },
              { name: "user_id", type: "int" },
              { name: "total", type: "decimal" },
              { name: "created_at", type: "timestamp" },
            ],
          },
          {
            name: "products",
            columns: [
              { name: "id", type: "int" },
              { name: "name", type: "varchar" },
              { name: "price", type: "decimal" },
              { name: "stock", type: "int" },
            ],
          },
        ]);
      } finally {
        setLoading(false);
      }
    };

    loadTables();
  }, [effectiveConnectionId]);

  // Handle connection between nodes
  const onConnect = useCallback(
    (params: Connection) => {
      const sourceNode = nodes.find((n) => n.id === params.source);
      const targetNode = nodes.find((n) => n.id === params.target);
      if (!sourceNode || !targetNode || !params.source || !params.target) return;

      const newEdge: Edge = {
        id: `e-${params.source}-${params.target}`,
        source: params.source,
        target: params.target,
        type: "join",
        data: {
          type: "INNER",
          condition: `${sourceNode.data.label}.id = ${targetNode.data.label}.${sourceNode.data.label}_id`,
        },
        markerEnd: { type: MarkerType.ArrowClosed },
      };

      setEdges((eds) => addEdge(newEdge, eds));
    },
    [nodes, setEdges]
  );

  // Add a table as a node
  const addTableNode = useCallback((table: TableInfo) => {
    const newNode: Node = {
      id: table.name,
      type: "table",
      position: { x: Math.random() * 400 + 100, y: Math.random() * 300 + 100 },
      data: {
        label: table.name,
        columns: table.columns,
        selectedColumns: [],
        onSelectColumn: (col: string) => {
          setSelectedColumns((prev) =>
            prev.includes(col) ? prev.filter((c) => c !== col) : [...prev, col]
          );
          // Update the node's selectedColumns
          setNodes((prevNodes) =>
            prevNodes.map((n) =>
              n.id === table.name
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      selectedColumns: n.data.selectedColumns.includes(col)
                        ? n.data.selectedColumns.filter((c: string) => c !== col)
                        : [...n.data.selectedColumns, col],
                    },
                  }
                : n
            )
          );
        },
        onRemove: () => removeTableNode(table.name),
      },
    };

    setNodes((prevNodes) => [...prevNodes, newNode]);
  }, [setNodes]);

  // Remove a table node
  const removeTableNode = useCallback((nodeId: string) => {
    setNodes((prevNodes) => prevNodes.filter((n) => n.id !== nodeId));
    setEdges((prevEdges) => prevEdges.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelectedColumns((prev) => prev.filter((c) => !c.startsWith(nodeId + ".")));
  }, [setNodes, setEdges]);

  // Add a filter
  const addFilter = useCallback(() => {
    if (selectedColumns.length === 0) return;
    const newFilter: Filter = {
      id: Date.now().toString(),
      column: selectedColumns[0] || "",
      operator: "=",
      value: "",
    };
    setFilters((prev) => [...prev, newFilter]);
  }, [selectedColumns]);

  // Update a filter
  const updateFilter = useCallback((id: string, updates: Partial<Filter>) => {
    setFilters((prev) =>
      prev.map((f) => (f.id === id ? { ...f, ...updates } : f))
    );
  }, []);

  // Remove a filter
  const removeFilter = useCallback((id: string) => {
    setFilters((prev) => prev.filter((f) => f.id !== id));
  }, []);

  // Update a join
  const updateJoin = useCallback((edgeId: string, updates: Partial<{ type: string; condition: string }>) => {
    setEdges((prev) =>
      prev.map((e) =>
        e.id === edgeId ? { ...e, data: { ...e.data, ...updates } } : e
      )
    );
  }, []);

  // Remove a join
  const removeJoin = useCallback((edgeId: string) => {
    setEdges((prev) => prev.filter((e) => e.id !== edgeId));
  }, []);

  // Generate SQL
  const generateSQL = useCallback(() => {
    const tableNames = nodes.map((n) => n.data.label);
    if (tableNames.length === 0 || selectedColumns.length === 0) {
      return `-- ${t('builder.noTablesSelected')}`;
    }

    let sql = `SELECT ${selectedColumns.join(", ")} FROM ${tableNames.join(", ")}`;

    if (edges.length > 0) {
      edges.forEach((edge) => {
        if (edge.data) {
          sql += ` ${edge.data.type} JOIN ${edge.target} ON ${edge.data.condition}`;
        }
      });
    }

    if (filters.length > 0) {
      sql += " WHERE ";
      sql += filters.map((f) => `${f.column} ${f.operator} '${f.value}'`).join(" AND ");
    }

    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    return sql;
  }, [nodes, edges, selectedColumns, filters, limit]);

  const handleRunQuery = useCallback(() => {
    const sql = generateSQL();
    onQueryGenerated(sql);
  }, [generateSQL, onQueryGenerated]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-background text-foreground">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-border border-t-[hsl(var(--tab-active))] rounded-full animate-spin"></div>
          <span>{t('common.loading')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex items-center justify-between bg-muted px-4 py-2 border-b border-border">
        <div className="flex items-center space-x-2">
          <button
            onClick={onClose}
            className="p-2 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title={t('builder.close')}
          >
            <X className="w-4 h-4" />
          </button>
          <h1 className="text-lg font-medium text-foreground">{t('builder.title')}</h1>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleRunQuery}
            className="flex items-center space-x-2 bg-[hsl(var(--tab-active))] hover:opacity-90 text-white px-4 py-2 rounded transition-colors"
          >
            <Play className="w-4 h-4" />
            <span>{t('builder.runQuery')}</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel - Table Library */}
        <div className="w-64 border-r border-border bg-muted overflow-y-auto">
          <div className="p-4">
            <h3 className="text-sm font-medium mb-3 text-foreground flex items-center gap-2">
              <Database size={16} />
              {t('builder.availableTables')}
            </h3>
            <div className="space-y-2">
              {availableTables.map((table) => {
                const isAdded = nodes.some((n) => n.id === table.name);
                return (
                  <div
                    key={table.name}
                    className={`p-3 border border-border rounded-lg bg-card cursor-pointer transition-all hover:border-[hsl(var(--tab-active))] ${
                      isAdded ? "opacity-50 cursor-not-allowed" : ""
                    }`}
                    onClick={() => !isAdded && addTableNode(table)}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">{table.name}</span>
                      {!isAdded && <Plus size={14} className="text-[hsl(var(--tab-active))]" />}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {table.columns.length} {t('builder.columns')}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Filters Section */}
            {selectedColumns.length > 0 && (
              <div className="mt-6">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-foreground flex items-center gap-2">
                    <Filter size={16} />
                    {t('builder.filters')}
                  </h3>
                  <button
                    onClick={addFilter}
                    className="p-1 rounded hover:bg-accent text-muted-foreground"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                <div className="space-y-2">
                  {filters.map((filter) => (
                    <div key={filter.id} className="p-2 border border-border rounded bg-card">
                      <div className="flex items-center gap-2 mb-2">
                        <select
                          value={filter.column}
                          onChange={(e) => updateFilter(filter.id, { column: e.target.value })}
                          className="flex-1 text-xs px-2 py-1 bg-muted border border-border rounded text-foreground"
                        >
                          {selectedColumns.map((col) => (
                            <option key={col} value={col}>{col}</option>
                          ))}
                        </select>
                        <select
                          value={filter.operator}
                          onChange={(e) => updateFilter(filter.id, { operator: e.target.value })}
                          className="w-20 text-xs px-2 py-1 bg-muted border border-border rounded text-foreground"
                        >
                          <option value="=">=</option>
                          <option value="!=">!=</option>
                          <option value=">">{">"}</option>
                          <option value=">=">{">="}</option>
                          <option value="<">{"<"}</option>
                          <option value="<=">{"<="}</option>
                          <option value="LIKE">LIKE</option>
                          <option value="IN">IN</option>
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={filter.value}
                          onChange={(e) => updateFilter(filter.id, { value: e.target.value })}
                          className="flex-1 text-xs px-2 py-1 bg-muted border border-border rounded text-foreground"
                          placeholder="Value"
                        />
                        <button
                          onClick={() => removeFilter(filter.id)}
                          className="p-1 rounded hover:bg-destructive/20 text-destructive"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Limit */}
            <div className="mt-6">
              <h3 className="text-sm font-medium mb-2 text-foreground flex items-center gap-2">
                <Settings size={16} />
                {t('builder.limit')}
              </h3>
              <input
                type="text"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                className="w-full text-xs px-2 py-1 bg-muted border border-border rounded text-foreground"
              />
            </div>
          </div>
        </div>

        {/* Middle Panel - Visual Query Builder */}
        <div className="flex-1 relative" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={setReactFlowInstance}
            fitView
            className="bg-background"
          >
            <Background gap={16} size={1} />
            <Controls />
            <MiniMap nodeColor={() => "#3b82f6"} nodeStrokeWidth={3} />
            
            {/* Panel for SQL Preview */}
            <Panel position="bottom-right" className="bg-card border border-border rounded-lg p-3 shadow-lg max-w-md">
              <h4 className="text-xs font-medium mb-2 text-foreground">{t('builder.preview')}</h4>
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap max-h-[200px] overflow-y-auto">
                {generateSQL()}
              </pre>
            </Panel>
          </ReactFlow>
        </div>

        {/* Right Panel - Joins Management */}
        {edges.length > 0 && (
          <div className="w-80 border-l border-border bg-muted overflow-y-auto">
            <div className="p-4">
              <h3 className="text-sm font-medium mb-3 text-foreground flex items-center gap-2">
                <GitMerge size={16} />
                {t('builder.joins')}
              </h3>
              <div className="space-y-3">
                {edges.map((edge) => (
                  <div key={edge.id} className="p-3 border border-border rounded-lg bg-card">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-medium text-foreground">
                        {edge.source} → {edge.target}
                      </span>
                      <button
                        onClick={() => removeJoin(edge.id)}
                        className="p-1 rounded hover:bg-destructive/20 text-destructive"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <select
                      value={edge.data?.type || "INNER"}
                      onChange={(e) => updateJoin(edge.id, { type: e.target.value })}
                      className="w-full text-xs px-2 py-1 mb-2 bg-muted border border-border rounded text-foreground"
                    >
                      <option value="INNER">INNER JOIN</option>
                      <option value="LEFT">LEFT JOIN</option>
                      <option value="RIGHT">RIGHT JOIN</option>
                      <option value="FULL">FULL JOIN</option>
                    </select>
                    <input
                      type="text"
                      value={edge.data?.condition || ""}
                      onChange={(e) => updateJoin(edge.id, { condition: e.target.value })}
                      className="w-full text-xs px-2 py-1 bg-muted border border-border rounded text-foreground"
                      placeholder="Join condition"
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// Wrap with provider
const VisualQueryBuilderWrapper: React.FC<QueryBuilderProps> = (props) => {
  return (
    <ReactFlowProvider>
      <VisualQueryBuilder {...props} />
    </ReactFlowProvider>
  );
};

export default VisualQueryBuilderWrapper;
