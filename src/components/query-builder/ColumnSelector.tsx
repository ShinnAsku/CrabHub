import React from "react";
import { Columns, Plus, X } from "lucide-react";

interface Table {
  name: string;
  columns: Column[];
}

interface Column {
  name: string;
  type: string;
}

interface ColumnSelectorProps {
  tables: Table[];
  selectedColumns: string[];
  onAddColumn: (column: string) => void;
  onRemoveColumn: (column: string) => void;
}

const ColumnSelector: React.FC<ColumnSelectorProps> = ({ 
  tables, 
  selectedColumns, 
  onAddColumn, 
  onRemoveColumn 
}) => {
  const getAvailableColumns = () => {
    const allColumns: string[] = [];
    tables.forEach(table => {
      table.columns.forEach(column => {
        const fullColumn = `${table.name}.${column.name}`;
        if (!selectedColumns.includes(fullColumn)) {
          allColumns.push(fullColumn);
        }
      });
    });
    return allColumns;
  };

  const availableColumns = getAvailableColumns();

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-foreground flex items-center space-x-2">
          <Columns className="w-4 h-4" />
          <span>Columns</span>
        </h3>
      </div>
      
      {/* Selected Columns */}
      <div className="mb-3">
        <h4 className="text-xs font-medium text-muted-foreground mb-2">Selected Columns</h4>
        <div className="space-y-1">
          {selectedColumns.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">No columns selected</div>
          ) : (
            selectedColumns.map(column => (
              <div key={column} className="flex items-center justify-between bg-card px-3 py-2 rounded border border-border">
                <span className="text-sm">{column}</span>
                <button
                  onClick={() => onRemoveColumn(column)}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      
      {/* Available Columns */}
      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-2">Available Columns</h4>
        <div className="space-y-1">
          {availableColumns.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">All columns selected</div>
          ) : (
            availableColumns.map(column => (
              <button
                key={column}
                onClick={() => onAddColumn(column)}
                className="w-full flex items-center justify-between bg-card hover:bg-accent px-3 py-2 rounded border border-border transition-colors text-left"
              >
                <span className="text-sm">{column}</span>
                <Plus className="w-3 h-3 text-muted-foreground hover:text-success" />
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default ColumnSelector;