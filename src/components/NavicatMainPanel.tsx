import { useState, useCallback, useEffect } from "react";
import {
  Table,
  Eye,
  Database,
  FunctionSquare,
  User,
  Folder,
  Search,
  RefreshCw,
  Plus,
  Edit,
  Trash2,
  FileText,
  X,
  Info,
  List,
  Grid3X3,
} from "lucide-react";
import { useAppStore, type NavicatTab, type SchemaNode, type Connection } from "@/stores/app-store";
import { t } from "@/lib/i18n";
import { executeQuery, exportTableSql } from "@/lib/tauri-commands";

interface NavicatMainPanelProps {
  activeConnection: Connection | null;
  selectedSchemaName?: string;
}

const navicatTabs: { key: NavicatTab; icon: React.ReactNode; label: string }[] = [
  { key: "tables", icon: <Table size={18} />, label: "navicat.tables" },
  { key: "views", icon: <Eye size={18} />, label: "navicat.views" },
  { key: "materialized_views", icon: <Database size={18} />, label: "navicat.materializedViews" },
  { key: "functions", icon: <FunctionSquare size={18} />, label: "navicat.functions" },
  { key: "roles", icon: <User size={18} />, label: "navicat.roles" },
  { key: "other", icon: <Folder size={18} />, label: "navicat.other" },
  { key: "queries", icon: <FileText size={18} />, label: "navicat.queries" },
  { key: "backups", icon: <Database size={18} />, label: "navicat.backups" },
];

interface OpenTab {
  id: string;
  type: "table";
  tableId: string;
  tableName: string;
  schemaName?: string;
}

function NavicatMainPanel({ activeConnection, selectedSchemaName: propsSelectedSchemaName }: NavicatMainPanelProps) {
  const {
    activeNavicatTab,
    setActiveNavicatTab,
    selectedSchemaName,
    selectedTable,
    selectedTableId,
    selectedTableData,
    selectedTableDDL,
    schemaData,
  } = useAppStore();
  
  // Use props selectedSchemaName if provided, otherwise use store value
  const currentSchemaName = propsSelectedSchemaName ?? selectedSchemaName;

  const [searchTerm, setSearchTerm] = useState("");
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [loading, setLoading] = useState(false);
  const [openTabs, setOpenTabs] = useState<OpenTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showObjectList, setShowObjectList] = useState(true);

  const connectionSchema = activeConnection ? schemaData[activeConnection.id] : [];

  const getTablesForTab = useCallback(() => {
    if (!connectionSchema) return [];

    let tables: SchemaNode[] = [];

    if (currentSchemaName) {
      const schemaNode = connectionSchema.find(
        (n) => n.type === "schema" && n.name === currentSchemaName
      );
      if (schemaNode && schemaNode.children) {
        tables = schemaNode.children;
      }
    } else {
      connectionSchema.forEach((node) => {
        if (node.type === "schema" && node.children) {
          tables = [...tables, ...node.children];
        } else if (node.type === "table" || node.type === "view") {
          tables.push(node);
        }
      });
    }

    // 根据当前选中的Navicat标签页过滤
    switch (activeNavicatTab) {
      case "tables":
        tables = tables.filter((t) => t.type === "table");
        break;
      case "views":
        tables = tables.filter((t) => t.type === "view");
        break;
      case "materialized_views":
        tables = tables.filter((t) => t.type === "materialized_view");
        break;
      case "functions":
        tables = tables.filter((t) => t.type === "function");
        break;
      case "roles":
        tables = tables.filter((t) => t.type === "role");
        break;
      case "backups":
        tables = tables.filter((t) => t.type === "backup");
        break;
      // queries 和 other 暂时显示所有类型
      default:
        break;
    }

    if (searchTerm) {
      tables = tables.filter((t) =>
        t.name.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }

    return tables;
  }, [connectionSchema, searchTerm, currentSchemaName, activeNavicatTab]);

  const tables = getTablesForTab();

  const formatValue = (value: any): string => {
    if (value === null || value === undefined || value === "") {
      return "";
    }
    // 直接将所有值转换为字符串显示
    return String(value);
  };

  const loadTableData = useCallback(async (table: SchemaNode) => {
    if (!activeConnection) return;

    setLoading(true);
    try {
      const schemaPrefix = table.schema ? `${table.schema}.` : "";
      const sql = `SELECT * FROM ${schemaPrefix}${table.name} LIMIT 100;`;
      const result = await executeQuery(activeConnection.id, sql);
      useAppStore.getState().setSelectedTableData(result);
      
      try {
        const ddl = await exportTableSql(activeConnection.id, table.name, table.schema);
        useAppStore.getState().setSelectedTableDDL(ddl);
      } catch {
        useAppStore.getState().setSelectedTableDDL("-- DDL not available");
      }
    } catch (err) {
      console.error("Failed to load table data:", err);
    } finally {
      setLoading(false);
    }
  }, [activeConnection]);

  const handleTableClick = useCallback((table: SchemaNode) => {
    const existingTab = openTabs.find((t) => t.tableId === table.id);

    if (existingTab) {
      setActiveTabId(existingTab.id);
    } else {
      const newTab: OpenTab = {
        id: `tab-${Date.now()}`,
        type: "table",
        tableId: table.id,
        tableName: table.name,
        schemaName: table.schema,
      };
      setOpenTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    }
    
    setShowObjectList(false);
    loadTableData(table);
  }, [openTabs, loadTableData]);

  const handleCloseTab = useCallback((tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs((prev) => {
      const newTabs = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        if (newTabs.length > 0) {
          const lastTab = newTabs[newTabs.length - 1];
          if (lastTab) {
            setActiveTabId(lastTab.id);
          } else {
            setActiveTabId(null);
            setShowObjectList(true);
          }
        } else {
          setActiveTabId(null);
          setShowObjectList(true);
        }
      }
      return newTabs;
    });
  }, [activeTabId]);

  // 当 selectedTable 变化时，自动加载表数据并打开标签页
  useEffect(() => {
    if (selectedTable && activeConnection) {
      handleTableClick(selectedTable);
    }
  }, [selectedTable, activeConnection, handleTableClick]);

  // 当 currentSchemaName 变化时，显示对象列表
  useEffect(() => {
    if (currentSchemaName) {
      setShowObjectList(true);
    }
  }, [currentSchemaName]);

  const activeTab = activeTabId ? openTabs.find((t) => t.id === activeTabId) : null;

  // 当 activeTab 变化时，加载对应表的数据
  useEffect(() => {
    if (activeTab && activeConnection) {
      // 从 schemaData 中找到对应的表节点
      const findTableNode = (nodes: SchemaNode[]): SchemaNode | undefined => {
        for (const node of nodes) {
          if (node.id === activeTab.tableId) {
            return node;
          }
          if (node.children) {
            const found = findTableNode(node.children);
            if (found) {
              return found;
            }
          }
        }
        return undefined;
      };

      const tableNode = findTableNode(connectionSchema);
      if (tableNode) {
        loadTableData(tableNode);
      }
    }
  }, [activeTab, activeConnection, connectionSchema, loadTableData]);

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Navicat-style Tabs */}
      <div className="flex border-b border-border px-2 bg-muted/30">
        {navicatTabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveNavicatTab(tab.key)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border-t-2 transition-colors ${
              activeNavicatTab === tab.key
                ? "border-[hsl(var(--tab-active))] bg-background text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            {tab.icon}
            <span>{t(tab.label)}</span>
          </button>
        ))}
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Object List - 只在显示对象列表时显示 */}
        {showObjectList && (
          <div className="w-1/2 border-r border-border flex flex-col">
            {/* Object List Toolbar */}
            <div className="flex items-center justify-between px-2 py-1 border-b border-border">
              <div className="flex items-center gap-1">
                <span className="text-xs font-medium text-foreground">{t('navicat.objects')}</span>
              </div>
              <div className="flex items-center gap-1">
                <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                  <Info size={14} />
                </button>
                <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                  <List size={14} />
                </button>
                <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                  <Grid3X3 size={14} />
                </button>
              </div>
            </div>

            {/* Object List Action Buttons */}
            <div className="flex items-center gap-1 px-2 py-1 border-b border-border">
              <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                <Folder size={14} />
              </button>
              <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                <Edit size={14} />
              </button>
              <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                <Plus size={14} />
              </button>
              <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                <Trash2 size={14} />
              </button>
              <div className="w-1/2" />
              <div className="flex items-center gap-0.5">
                <button
                  onClick={() => setViewMode("list")}
                  className={`p-1 rounded ${viewMode === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <List size={14} />
                </button>
                <button
                  onClick={() => setViewMode("grid")}
                  className={`p-1 rounded ${viewMode === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  <Grid3X3 size={14} />
                </button>
              </div>
              <div className="w-1/2" />
              <div className="flex-1 relative max-w-[150px]">
                <Search size={12} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder={t('common.search')}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-6 pr-2 py-0.5 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))]"
                />
              </div>
            </div>

            {/* Table List */}
            <div className="flex-1 overflow-y-auto">
              {viewMode === "list" ? (
                <table className="w-full text-xs">
                  <thead className="bg-muted/30 sticky top-0">
                    <tr>
                      <th className="text-left px-2 py-1 font-medium text-muted-foreground">{t('common.name')}</th>
                      <th className="text-left px-2 py-1 font-medium text-muted-foreground">OID</th>
                      <th className="text-left px-2 py-1 font-medium text-muted-foreground">所有者</th>
                      <th className="text-left px-2 py-1 font-medium text-muted-foreground">ACL</th>
                      <th className="text-left px-2 py-1 font-medium text-muted-foreground">表类型</th>
                      <th className="text-left px-2 py-1 font-medium text-muted-foreground">分区属于</th>
                      <th className="text-left px-2 py-1 font-medium text-muted-foreground">行</th>
                      <th className="text-left px-2 py-1 font-medium text-muted-foreground">主键</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tables.map((table) => (
                      <tr
                        key={table.id}
                        onClick={() => handleTableClick(table)}
                        className={`cursor-pointer hover:bg-muted/50 ${
                          selectedTableId === table.id ? "bg-[hsl(var(--tab-active))]/10" : ""
                        }`}
                      >
                        <td className="px-2 py-1 flex items-center gap-1">
                          {table.type === "view" ? <Eye size={12} /> : <Table size={12} />}
                          {table.name}
                        </td>
                        <td className="px-2 py-1 text-muted-foreground">-</td>
                        <td className="px-2 py-1 text-muted-foreground">-</td>
                        <td className="px-2 py-1 text-muted-foreground">-</td>
                        <td className="px-2 py-1 text-muted-foreground">
                          {table.type === "view" ? "视图" : "常规"}
                        </td>
                        <td className="px-2 py-1 text-muted-foreground">-</td>
                        <td className="px-2 py-1 text-muted-foreground">-</td>
                        <td className="px-2 py-1 text-muted-foreground">-</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="grid grid-cols-4 gap-2 p-2">
                  {tables.map((table) => (
                    <div
                      key={table.id}
                      onClick={() => handleTableClick(table)}
                      className={`flex flex-col items-center p-2 rounded cursor-pointer hover:bg-muted/50 ${
                        selectedTableId === table.id ? "bg-[hsl(var(--tab-active))]/10" : ""
                      }`}
                    >
                      {table.type === "view" ? <Eye size={24} className="mb-1" /> : <Table size={24} className="mb-1" />}
                      <span className="text-xs text-center truncate w-full">{table.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Right: Tabs + Data + DDL */}
        <div className={`flex-1 flex flex-col ${showObjectList ? "" : "w-full"}`}>
          {/* Table Tabs */}
          {openTabs.length > 0 && (
            <div className="flex border-b border-border px-2 bg-muted/30">
              {/* 返回对象列表按钮 */}
              {!showObjectList && (
                <button
                  onClick={() => setShowObjectList(true)}
                  className="flex items-center gap-1 px-2 py-1 text-xs border-t-2 border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
                >
                  <List size={14} />
                </button>
              )}
              {openTabs.map((tab) => (
                <div
                  key={tab.id}
                  onClick={() => setActiveTabId(tab.id)}
                  className={`flex items-center gap-1 px-3 py-1 text-xs border-t-2 cursor-pointer transition-colors ${
                    activeTabId === tab.id
                      ? "border-[hsl(var(--tab-active))] bg-background text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  }`}
                >
                  <Table size={14} />
                  <span>
                    {tab.schemaName ? `${tab.schemaName}.` : ""}
                    {tab.tableName}
                  </span>
                  <button
                    onClick={(e) => handleCloseTab(tab.id, e)}
                    className="ml-1 p-0.5 rounded hover:bg-muted/50"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Data + DDL Panels */}
          {activeTab && selectedTable ? (
            <div className="flex-1 flex overflow-hidden">
              {/* Data Panel */}
              <div className="flex-1 flex flex-col border-r border-border">
                {/* Data Toolbar */}
                <div className="flex items-center gap-1 px-2 py-1 border-b border-border">
                  <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                    <Database size={14} />
                  </button>
                  <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                    <RefreshCw size={14} />
                  </button>
                  <div className="w-1/2" />
                  <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                    <FileText size={14} />
                  </button>
                  <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                    <Search size={14} />
                  </button>
                  <div className="w-1/2" />
                  <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                    <Table size={14} />
                  </button>
                </div>

                {/* Data Content */}
                <div className="flex-1 overflow-auto">
                  {loading ? (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                      {t('common.loading')}
                    </div>
                  ) : selectedTableData ? (
                    <table className="w-full text-xs">
                      <thead className="bg-muted/30 sticky top-0">
                        <tr>
                          {selectedTableData.columns.map((col, idx) => (
                            <th key={idx} className="text-left px-2 py-1 font-medium text-muted-foreground border-r border-border last:border-r-0">
                              {col.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {selectedTableData.rows.map((row, rowIdx) => (
                          <tr key={rowIdx} className="hover:bg-muted/30">
                            {selectedTableData.columns.map((col, colIdx) => {
                              // 尝试直接使用列名获取值
                              let value = row[col.name];
                              
                              // 如果值不存在，尝试使用大小写不敏感的方式获取
                              if (value === undefined) {
                                const key = Object.keys(row).find(
                                  (k) => k.toLowerCase() === col.name.toLowerCase()
                                );
                                if (key) {
                                  value = row[key];
                                }
                              }
                              
                              return (
                                <td key={colIdx} className="px-2 py-1 border-r border-border last:border-r-0">
                                  {formatValue(value)}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                      选择一个表查看数据
                    </div>
                  )}
                </div>
              </div>

              {/* DDL Panel */}
              <div className="w-1/3 flex flex-col">
                {/* DDL Toolbar */}
                <div className="flex items-center justify-between px-2 py-1 border-b border-border">
                  <span className="text-xs font-medium text-foreground">{t('navicat.ddl')}</span>
                  <div className="flex items-center gap-1">
                    <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                      <Info size={14} />
                    </button>
                    <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                      <List size={14} />
                    </button>
                    <button className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
                      <Grid3X3 size={14} />
                    </button>
                  </div>
                </div>

                {/* DDL Content */}
                <div className="flex-1 overflow-auto p-2 bg-muted/10">
                  {selectedTableDDL ? (
                    <pre className="text-xs font-mono whitespace-pre-wrap text-blue-500">
                      {selectedTableDDL}
                    </pre>
                  ) : (
                    <div className="text-muted-foreground text-sm">
                      选择一个表查看 DDL
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              {currentSchemaName
                ? `选择 ${currentSchemaName} 中的一个表`
                : "点击左侧的 schema 或表"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default NavicatMainPanel;
