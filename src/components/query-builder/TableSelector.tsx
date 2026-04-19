import React from "react";
import { Table, Plus, X } from "lucide-react";

interface Table {
  name: string;
  columns: Column[];
}

interface Column {
  name: string;
  type: string;
}

interface TableSelectorProps {
  tables: Table[];
  selectedTables: string[];
  onAddTable: (tableName: string) => void;
  onRemoveTable: (tableName: string) => void;
}

const TableSelector: React.FC<TableSelectorProps> = ({ 
  tables, 
  selectedTables, 
  onAddTable, 
  onRemoveTable 
}) => {
  const availableTables = tables.filter(table => !selectedTables.includes(table.name));

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-foreground flex items-center space-x-2">
          <Table className="w-4 h-4" />
          <span>Tables</span>
        </h3>
      </div>
      
      {/* Selected Tables */}
      <div className="mb-3">
        <h4 className="text-xs font-medium text-muted-foreground mb-2">Selected Tables</h4>
        <div className="space-y-1">
          {selectedTables.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">No tables selected</div>
          ) : (
            selectedTables.map(tableName => {
              const table = tables.find(t => t.name === tableName);
              return (
                <div key={tableName} className="flex items-center justify-between bg-card px-3 py-2 rounded border border-border">
                  <span className="text-sm">{tableName}</span>
                  <button
                    onClick={() => onRemoveTable(tableName)}
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
      
      {/* Available Tables */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-2">Available Tables</h4>
        <div className="space-y-1">
          {availableTables.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">All tables selected</div>
          ) : (
            availableTables.map(table => (
              <button
                key={table.name}
                onClick={() => onAddTable(table.name)}
                className="w-full flex items-center justify-between bg-card hover:bg-accent px-3 py-2 rounded border border-border transition-colors text-left"
              >
                <span className="text-sm">{table.name}</span>
                <Plus className="w-3 h-3 text-muted-foreground hover:text-success" />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default TableSelector;