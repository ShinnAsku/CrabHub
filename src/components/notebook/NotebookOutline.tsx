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
    <div className="w-48 border-r border-border bg-muted/20 p-2 overflow-y-auto shrink-0">
      <span className="text-[11px] font-medium text-muted-foreground uppercase mb-2 block">Outline</span>
      <div className="space-y-0.5">
        {cells.map((cell) => (
          <div
            key={cell.id}
            onClick={() => onCellClick(cell.id)}
            className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer transition-colors text-xs ${
              activeCellId === cell.id
                ? "bg-[hsl(var(--tab-active))]/20 border border-[hsl(var(--tab-active))]/50"
                : "hover:bg-muted/50 border border-transparent"
            }`}
          >
            {cell.type === "sql" ? (
              <Code size={12} className="text-[hsl(var(--tab-active))] shrink-0" />
            ) : (
              <FileText size={12} className="text-green-500 shrink-0" />
            )}
            <span className="text-foreground truncate">{cell.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default NotebookOutline;