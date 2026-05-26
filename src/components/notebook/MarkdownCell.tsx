import React, { useState } from "react";
import { Trash2, ArrowUp, ArrowDown, Plus, FileText, Code, Settings } from "lucide-react";
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

interface MarkdownCellProps {
  cell: Cell;
  isActive: boolean;
  onContentChange: (content: string) => void;
  onNameChange: (name: string) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAddSqlAfter: () => void;
  onAddMarkdownAfter: () => void;
}

const MarkdownCell: React.FC<MarkdownCellProps> = ({
  cell,
  isActive,
  onContentChange,
  onNameChange,
  onDelete,
  onMoveUp,
  onMoveDown,
  onAddSqlAfter,
  onAddMarkdownAfter
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(true);
  const [isEditingName, setIsEditingName] = useState<boolean>(false);
  const [editName, setEditName] = useState<string>(cell.name);
  const [isEditing, setIsEditing] = useState<boolean>(false);

  const handleNameSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onNameChange(editName);
    setIsEditingName(false);
  };

  const renderMarkdown = (content: string) => {
    // Simple markdown rendering (for demonstration)
    return (
      <div className="prose prose-invert max-w-none">
        {content
          .split('\n')
          .map((line, index) => {
            if (line.startsWith('# ')) {
              return <h1 key={index} className="text-sm font-bold mb-1">{line.substring(2)}</h1>;
            } else if (line.startsWith('## ')) {
              return <h2 key={index} className="text-xs font-bold mb-1">{line.substring(3)}</h2>;
            } else if (line.startsWith('### ')) {
              return <h3 key={index} className="text-xs font-semibold mb-1">{line.substring(4)}</h3>;
            } else if (line.startsWith('- ')) {
              return <li key={index} className="text-xs mb-0.5">{line.substring(2)}</li>;
            } else if (line === '') {
              return <br key={index} />;
            } else {
              return <p key={index} className="text-xs mb-1">{line}</p>;
            }
          })}
      </div>
    );
  };

  return (
    <div className={`border rounded overflow-hidden ${isActive ? "border-[hsl(var(--tab-active))]" : "border-border"} ${isExpanded ? "" : "h-8"}`}>
      {/* Cell Header */}
      <div className="flex items-center justify-between bg-muted/30 px-2 py-0.5">
        <div className="flex items-center gap-1">
          <FileText size={14} className="text-green-500 shrink-0" />
          {isEditingName ? (
            <form onSubmit={handleNameSubmit} className="flex items-center">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="bg-background text-foreground px-1.5 py-0.5 rounded text-xs focus:outline-none focus:ring-1 focus:ring-[hsl(var(--tab-active))] border border-border w-40"
                autoFocus
                onBlur={handleNameSubmit}
              />
            </form>
          ) : (
            <span
              className="text-xs font-medium cursor-pointer hover:text-[hsl(var(--tab-active))] truncate max-w-[200px]"
              onClick={() => setIsEditingName(true)}
            >
              {cell.name}
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={isExpanded ? t('common.collapse') : t('common.expand')}
          >
            <Settings size={12} />
          </button>
          <button aria-label={t('notebook.addSqlCell')} onClick={onAddSqlAfter}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={t('notebook.addSqlCell')}
          >
            <Code size={12} />
          </button>
          <button aria-label={t('notebook.addMarkdownCell')} onClick={onAddMarkdownAfter}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={t('notebook.addMarkdownCell')}
          >
            <Plus size={12} />
          </button>
          <button aria-label={t('notebook.moveUp')} onClick={onMoveUp}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={t('notebook.moveUp')}
          >
            <ArrowUp size={12} />
          </button>
          <button aria-label={t('notebook.moveDown')} onClick={onMoveDown}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title={t('notebook.moveDown')}
          >
            <ArrowDown size={12} />
          </button>
          <button aria-label={t('notebook.deleteCell')} onClick={onDelete}
            className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive transition-colors"
            title={t('notebook.deleteCell')}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Cell Content */}
      {isExpanded && (
        <div className="p-2">
          {isEditing ? (
            <textarea
              value={cell.content}
              onChange={(e) => onContentChange(e.target.value)}
              className="w-full h-48 bg-background text-foreground px-4 py-2 rounded border border-border focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              onBlur={() => setIsEditing(false)}
              autoFocus
            />
          ) : (
            <div 
              className="cursor-text"
              onClick={() => setIsEditing(true)}
            >
              {renderMarkdown(cell.content)}
            </div>
          )}
          {!isEditing && (
            <button
              onClick={() => setIsEditing(true)}
              className="mt-2 text-sm text-primary hover:text-primary/80"
            >
              {t('common.click')} {t('common.edit')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default MarkdownCell;