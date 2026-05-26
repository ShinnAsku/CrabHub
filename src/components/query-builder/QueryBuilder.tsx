import React, { useState, useCallback, useEffect } from "react";
import { Play, X, Table, Filter, Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import TableSelector from "./TableSelector";
import ColumnSelector from "./ColumnSelector";
import FilterBuilder from "./FilterBuilder";
import JoinBuilder from "./JoinBuilder";
import QueryPreview from "./QueryPreview";
import { log } from "@/lib/log";
import { getTables, getColumns } from "@/lib/tauri-commands";

interface Table {
  name: string;
  columns: Column[];
}

interface Column {
  name: string;
  type: string;
}

interface Filter {
  id: string;
  column: string;
  operator: string;
  value: string;
}

interface Join {
  id: string;
  table: string;
  type: string;
  condition: string;
}

interface QueryBuilderProps {
  connectionId: string;
  onClose: () => void;
  onQueryGenerated: (sql: string) => void;
}

const QueryBuilder: React.FC<QueryBuilderProps> = ({
  connectionId,
  onClose,
  onQueryGenerated
}) => {
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load real tables and columns from the database
  useEffect(() => {
    if (!connectionId) return;
    setLoading(true);
    getTables(connectionId)
      .then(async (tableList) => {
        const result: Table[] = [];
        for (const t of tableList.slice(0, 50)) { // limit to 50 tables
          try {
            const cols = await getColumns(connectionId, t.name, t.schema || undefined);
            result.push({ name: t.name, columns: cols.map((c: any) => ({ name: c.name, type: c.type || c.dataType || 'text' })) });
          } catch { result.push({ name: t.name, columns: [] }); }
        }
        setTables(result);
        if (result.length > 0) {
          const first = result[0]!;
          setSelectedTables([first.name]);
          setSelectedColumns(first.columns.slice(0, 5).map((c: Column) => `${first.name}.${c.name}`));
        }
      })
      .catch((e) => { log.error('QueryBuilder', 'Failed to load tables', e); setError(String(e)); })
      .finally(() => setLoading(false));
  }, [connectionId]);
  
  const [selectedTables, setSelectedTables] = useState<string[]>(["users"]);
  const [selectedColumns, setSelectedColumns] = useState<string[]>(["users.id", "users.name", "users.email"]);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [joins, setJoins] = useState<Join[]>([]);
  const [groupBy] = useState<string[]>([]);
  const [orderBy] = useState<string[]>([]);
  const [limit] = useState<string>("100");

  const addTable = useCallback((tableName: string) => {
    if (!selectedTables.includes(tableName)) {
      setSelectedTables(prev => [...prev, tableName]);
    }
  }, [selectedTables]);

  const removeTable = useCallback((tableName: string) => {
    setSelectedTables(prev => prev.filter(t => t !== tableName));
    setSelectedColumns(prev => prev.filter(c => !c.startsWith(tableName + ".")));
  }, []);

  const addColumn = useCallback((column: string) => {
    if (!selectedColumns.includes(column)) {
      setSelectedColumns(prev => [...prev, column]);
    }
  }, [selectedColumns]);

  const removeColumn = useCallback((column: string) => {
    setSelectedColumns(prev => prev.filter(c => c !== column));
  }, []);

  const addFilter = useCallback(() => {
    const newFilter: Filter = {
      id: Date.now().toString(),
      column: selectedColumns[0] || "",
      operator: "=",
      value: ""
    };
    setFilters(prev => [...prev, newFilter]);
  }, [selectedColumns]);

  const updateFilter = useCallback((id: string, updates: Partial<Filter>) => {
    setFilters(prev => prev.map(filter => 
      filter.id === id ? { ...filter, ...updates } : filter
    ));
  }, []);

  const removeFilter = useCallback((id: string) => {
    setFilters(prev => prev.filter(filter => filter.id !== id));
  }, []);

  const addJoin = useCallback(() => {
    const availableTables = tables
      .map(t => t.name)
      .filter(t => !selectedTables.includes(t));
    
    if (availableTables.length > 0) {
      const newJoin: Join = {
        id: Date.now().toString(),
        table: availableTables[0] || "",
        type: "INNER",
        condition: ""
      };
      setJoins(prev => [...prev, newJoin]);
    }
  }, [tables, selectedTables]);

  const updateJoin = useCallback((id: string, updates: Partial<Join>) => {
    setJoins(prev => prev.map(join => 
      join.id === id ? { ...join, ...updates } : join
    ));
  }, []);

  const removeJoin = useCallback((id: string) => {
    setJoins(prev => prev.filter(join => join.id !== id));
  }, []);

  const generateSQL = useCallback(() => {
    if (selectedTables.length === 0 || selectedColumns.length === 0) {
      return `-- ${t('builder.noTablesSelected')}`;
    }

    let sql = `SELECT ${selectedColumns.join(", ")} FROM ${selectedTables.join(", ")}`;

    if (joins.length > 0) {
      joins.forEach(join => {
        sql += ` ${join.type} JOIN ${join.table} ON ${join.condition}`;
      });
    }

    if (filters.length > 0) {
      sql += " WHERE ";
      sql += filters.map(filter => `${filter.column} ${filter.operator} '${filter.value.replace(/'/g, "''")}'`).join(" AND ");
    }

    if (groupBy.length > 0) {
      sql += ` GROUP BY ${groupBy.join(", ")}`;
    }

    if (orderBy.length > 0) {
      sql += ` ORDER BY ${orderBy.join(", ")}`;
    }

    if (limit) {
      sql += ` LIMIT ${limit}`;
    }

    return sql;
  }, [selectedTables, selectedColumns, joins, filters, groupBy, orderBy, limit]);

  const handleRunQuery = useCallback(() => {
    const sql = generateSQL();
    onQueryGenerated(sql);
  }, [generateSQL, onQueryGenerated]);

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      {/* Toolbar */}
      <div className="flex items-center justify-between bg-muted px-4 py-2 border-b border-border">
        <div className="flex items-center space-x-2">
          <button aria-label={t('builder.close')} onClick={onClose}
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
            className="flex items-center space-x-2 bg-primary hover:opacity-90 text-primary-foreground px-4 py-2 rounded-md transition-colors"
          >
            <Play className="w-4 h-4" />
            <span>{t('builder.runQuery')}</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {loading ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin mr-2" /> {t('common.loading')}
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center text-red-500 text-sm px-8 text-center">
            {error}
          </div>
        ) : tables.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
            {t('sidebar.noTables')}
          </div>
        ) : (
        <>
        {/* Left Panel */}
        <div className="w-80 border-r border-border bg-muted overflow-y-auto">
          <div className="p-4">
            <TableSelector 
              tables={tables} 
              selectedTables={selectedTables}
              onAddTable={addTable}
              onRemoveTable={removeTable}
            />
            
            <ColumnSelector 
              tables={tables.filter(t => selectedTables.includes(t.name))}
              selectedColumns={selectedColumns}
              onAddColumn={addColumn}
              onRemoveColumn={removeColumn}
            />
            
            <FilterBuilder 
              filters={filters}
              availableColumns={selectedColumns}
              onAddFilter={addFilter}
              onUpdateFilter={updateFilter}
              onRemoveFilter={removeFilter}
            />
            
            <JoinBuilder 
              joins={joins}
              availableTables={tables.map(t => t.name).filter(t => !selectedTables.includes(t))}
              onAddJoin={addJoin}
              onUpdateJoin={updateJoin}
              onRemoveJoin={removeJoin}
            />
          </div>
        </div>

        {/* Right Panel */}
        <div className="flex-1 overflow-y-auto p-4">
          <QueryPreview 
            sql={generateSQL()}
            onSqlChange={(sql) => log.debug("SQL changed:", sql)}
          />
        </div>
        </>
        )}
      </div>
    </div>
  );
};

export default QueryBuilder;