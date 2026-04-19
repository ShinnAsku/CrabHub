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
              return <h1 key={index} className="text-2xl font-bold mb-4">{line.substring(2)}</h1>;
            } else if (line.startsWith('## ')) {
              return <h2 key={index} className="text-xl font-bold mb-3">{line.substring(3)}</h2>;
            } else if (line.startsWith('### ')) {
              return <h3 key={index} className="text-lg font-bold mb-2">{line.substring(4)}</h3>;
            } else if (line.startsWith('- ')) {
              return <li key={index} className="mb-1">{line.substring(2)}</li>;
            } else if (line === '') {
              return <br key={index} />;
            } else {
              return <p key={index} className="mb-2">{line}</p>;
            }
          })}
      </div>
    );
  };

  return (
    <div className={`border rounded-lg overflow-hidden ${isActive ? "border-primary" : "border-border"} ${isExpanded ? "" : "h-12"}`}>
      {/* Cell Header */}
      <div className="flex items-center justify-between bg-muted px-4 py-2">
        <div className="flex items-center space-x-2">
          <FileText className="w-4 h-4 text-success" />
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
            <Code className="w-4 h-4" />
          </button>
          <button
            onClick={onAddMarkdownAfter}
            className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
            title={t('notebook.addMarkdownCell')}
          >
            <Plus className="w-4 h-4" />
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
        <div className="p-4">
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