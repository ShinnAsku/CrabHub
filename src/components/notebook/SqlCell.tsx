import React, { useState } from "react";
import { Play, Trash2, ArrowUp, ArrowDown, Plus, FileText, Code, Settings } from "lucide-react";
import { t } from "@/lib/i18n";

interface Cell {
  id: string;
  type: "sql" | "markdown";
  content: string;
  name: string;
  executed: boolean;
  result?: any;
  error?: string;
}

interface SqlCellProps {
  cell: Cell;
  isActive: boolean;
  onContentChange: (content: string) => void;
  onNameChange: (name: string) => void;
  onRun: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddSqlAfter: () => void;
  onAddMarkdownAfter: () => void;
}

const SqlCell: React.FC<SqlCellProps> = ({
  cell,
  isActive,
  onContentChange,
  onNameChange,
  onRun,
  onDelete,
  onMoveUp,
  onMoveDown,
  onAddSqlAfter,
  onAddMarkdownAfter
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [isEditingName, setIsEditingName] = useState<boolean>(false);
  const [editName, setEditName] = useState<string>(cell.name);

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onNameChange(editName);
    setIsEditingName(false);
  };

  return (
    <div className={`border rounded-lg overflow-hidden ${isActive ? "border-primary" : "border-border"} ${isExpanded ? "" : "h-12"}`}>
      {/* Cell Header */}
      <div className="flex items-center justify-between bg-muted px-4 py-2">
        <div className="flex items-center space-x-2">
          <Code className="w-4 h-4 text-primary" />
          {isEditingName ? (
            <form onSubmit={handleNameSubmit} className="flex items-center">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="bg-background text-foreground px-2 py-1 rounded text-sm focus:outline-none focus:ring-1 focus:ring-ring border border-border"
                autoFocus
                onBlur={handleNameSubmit}
              />
            </form>
          ) : (
            <span 
              className="text-sm font-medium cursor-pointer hover:text-primary"
              onClick={() => setIsEditingName(true)}
            >
              {cell.name}
            </span>
          )}
        </div>
        
        <div className="flex items-center space-x-1">
          <button
            onClick={onRun}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title={t('notebook.runCell')}
          >
            <Play className="w-4 h-4" />
          </button>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title={isExpanded ? t('common.close') : t('common.expand')}
          >
            {isExpanded ? <Settings className="w-4 h-4" /> : <Settings className="w-4 h-4" />}
          </button>
          <button
            onClick={onAddSqlAfter}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title={t('notebook.addSqlCell')}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={onAddMarkdownAfter}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title={t('notebook.addMarkdownCell')}
          >
            <FileText className="w-4 h-4" />
          </button>
          <button
            onClick={onMoveUp}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title={t('notebook.moveUp')}
          >
            <ArrowUp className="w-4 h-4" />
          </button>
          <button
            onClick={onMoveDown}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title={t('notebook.moveDown')}
          >
            <ArrowDown className="w-4 h-4" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-colors"
            title={t('notebook.deleteCell')}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Cell Content */}
      {isExpanded && (
        <div className="flex flex-col">
          <div className="h-48 border-b border-border">
            <textarea
              value={cell.content}
              onChange={(e) => onContentChange(e.target.value)}
              className="w-full h-full p-4 bg-background text-foreground font-mono text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring border border-border"
              placeholder={t('notebook.sqlPlaceholder')}
            />
          </div>

          {/* Cell Result */}
          <div className="p-4">
            {cell.executed && cell.result && (
              <div className="bg-card rounded p-4 border border-border">
                <h4 className="text-sm font-medium mb-2 text-foreground">Results</h4>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-border">
                    <thead>
                      <tr>
                        {cell.result.columns.map((column: string, index: number) => (
                          <th key={index} className="px-4 py-2 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="bg-card divide-y divide-border">
                      {cell.result.rows.map((row: any[], index: number) => (
                        <tr key={index}>
                          {row.map((value: any, colIndex: number) => (
                            <td key={colIndex} className="px-4 py-2 text-sm text-foreground">
                              {value}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {cell.executed && cell.error && (
              <div className="bg-destructive/20 border border-destructive rounded p-4">
                <h4 className="text-sm font-medium mb-2 text-destructive">Error</h4>
                <p className="text-sm text-destructive">{cell.error}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SqlCell;