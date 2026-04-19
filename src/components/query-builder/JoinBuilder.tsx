import React from "react";
import { Plus, Minus, GitMerge } from "lucide-react";

interface Join {
  id: string;
  table: string;
  type: string;
  condition: string;
}

interface JoinBuilderProps {
  joins: Join[];
  availableTables: string[];
  onAddJoin: () => void;
  onUpdateJoin: (id: string, updates: Partial<Join>) => void;
  onRemoveJoin: (id: string) => void;
}

const JoinBuilder: React.FC<JoinBuilderProps> = ({
  joins,
  availableTables,
  onAddJoin,
  onUpdateJoin,
  onRemoveJoin
}) => {
  const joinTypes = ["INNER", "LEFT", "RIGHT", "FULL"];

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center space-x-2">
          <GitMerge className="w-4 h-4 text-primary" />
          <h3 className="font-medium text-foreground">Joins</h3>
        </div>
        <button
          onClick={onAddJoin}
          disabled={availableTables.length === 0}
          className="flex items-center space-x-1 text-sm bg-card hover:bg-accent text-foreground px-2 py-1 rounded border border-border transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Plus className="w-3 h-3" />
          <span>Add Join</span>
        </button>
      </div>

      {joins.length === 0 ? (
        <div className="text-sm text-muted-foreground italic">No joins added</div>
      ) : (
        <div className="space-y-3">
          {joins.map((join) => (
            <div key={join.id} className="bg-card rounded p-3 border border-border">
              <div className="flex items-start justify-between">
                <div className="flex-1 space-y-2">
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Join Type</label>
                    <select
                      value={join.type}
                      onChange={(e) => onUpdateJoin(join.id, { type: e.target.value })}
                      className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      {joinTypes.map((type) => (
                        <option key={type} value={type}>
                          {type} JOIN
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Table</label>
                    <select
                      value={join.table}
                      onChange={(e) => onUpdateJoin(join.id, { table: e.target.value })}
                      className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      {availableTables.map((table) => (
                        <option key={table} value={table}>
                          {table}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">Condition</label>
                    <input
                      type="text"
                      value={join.condition}
                      onChange={(e) => onUpdateJoin(join.id, { condition: e.target.value })}
                      placeholder="e.g. users.id = orders.user_id"
                      className="w-full bg-background border border-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  </div>
                </div>

                <button
                  onClick={() => onRemoveJoin(join.id)}
                  className="ml-3 p-2 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-colors"
                  title="Remove join"
                >
                  <Minus className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default JoinBuilder;