import React from "react";
import { Filter, Plus, X } from "lucide-react";

interface Filter {
  id: string;
  column: string;
  operator: string;
  value: string;
}

interface FilterBuilderProps {
  filters: Filter[];
  availableColumns: string[];
  onAddFilter: () => void;
  onUpdateFilter: (id: string, updates: Partial<Filter>) => void;
  onRemoveFilter: (id: string) => void;
}

const FilterBuilder: React.FC<FilterBuilderProps> = ({ 
  filters, 
  availableColumns, 
  onAddFilter, 
  onUpdateFilter, 
  onRemoveFilter 
}) => {
  const operators = ["=", "!=", ">", "<", ">=", "<=", "LIKE", "IN", "NOT IN"];

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-foreground flex items-center space-x-2">
          <Filter className="w-4 h-4" />
          <span>Filters</span>
        </h3>
        <button
          onClick={onAddFilter}
          disabled={availableColumns.length === 0}
          className="text-xs text-primary hover:text-primary/80 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add Filter
        </button>
      </div>
      
      <div className="space-y-3">
        {filters.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">No filters added</div>
        ) : (
          filters.map(filter => (
            <div key={filter.id} className="bg-card p-3 rounded border border-border space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">Filter {filters.indexOf(filter) + 1}</span>
                <button
                  onClick={() => onRemoveFilter(filter.id)}
                  className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              
              <div className="space-y-2">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Column</label>
                  <select
                    value={filter.column}
                    onChange={(e) => onUpdateFilter(filter.id, { column: e.target.value })}
                    className="w-full bg-background text-foreground px-2 py-1 rounded text-sm focus:outline-none focus:ring-1 focus:ring-ring border border-border"
                  >
                    <option value="">Select column</option>
                    {availableColumns.map(column => (
                      <option key={column} value={column}>{column}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Operator</label>
                  <select
                    value={filter.operator}
                    onChange={(e) => onUpdateFilter(filter.id, { operator: e.target.value })}
                    className="w-full bg-background text-foreground px-2 py-1 rounded text-sm focus:outline-none focus:ring-1 focus:ring-ring border border-border"
                  >
                    {operators.map(operator => (
                      <option key={operator} value={operator}>{operator}</option>
                    ))}
                  </select>
                </div>
                
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">Value</label>
                  <input
                    type="text"
                    value={filter.value}
                    onChange={(e) => onUpdateFilter(filter.id, { value: e.target.value })}
                    className="w-full bg-background text-foreground px-2 py-1 rounded text-sm focus:outline-none focus:ring-1 focus:ring-ring border border-border"
                    placeholder="Enter value"
                  />
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default FilterBuilder;