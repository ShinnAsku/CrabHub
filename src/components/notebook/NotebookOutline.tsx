import React from "react";
import { Code, FileText } from "lucide-react";

interface Cell {
  id: string;
  type: "sql" | "markdown";
  content: string;
  name: string;
  executed: boolean;
  result?: any;
  error?: string;
}

interface NotebookOutlineProps {
  cells: Cell[];
  activeCellId: string;
  onCellClick: (cellId: string) => void;
}

const NotebookOutline: React.FC<NotebookOutlineProps> = ({ cells, activeCellId, onCellClick }) => {
  return (
    <div className="w-64 border-r border-border bg-muted p-4 overflow-y-auto">
      <h3 className="text-sm font-medium text-foreground mb-4">Notebook Outline</h3>
      <div className="space-y-2">
        {cells.map((cell) => (
          <div
            key={cell.id}
            onClick={() => onCellClick(cell.id)}
            className={`flex items-center space-x-2 p-2 rounded cursor-pointer transition-colors ${activeCellId === cell.id ? "bg-primary/30 border border-primary" : "hover:bg-accent"}`}
          >
            {cell.type === "sql" ? (
              <Code className="w-4 h-4 text-primary" />
            ) : (
              <FileText className="w-4 h-4 text-success" />
            )}
            <span className="text-sm text-foreground truncate">{cell.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default NotebookOutline;