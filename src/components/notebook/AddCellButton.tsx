import { Code, FileText } from "lucide-react";

interface AddCellButtonProps {
  onAddSql: () => void;
  onAddMarkdown: () => void;
}

const AddCellButton: React.FC<AddCellButtonProps> = ({ onAddSql, onAddMarkdown }) => {
  return (
    <div className="flex gap-1.5">
      <button
        onClick={onAddSql}
        className="flex items-center gap-1.5 hover:bg-muted text-muted-foreground hover:text-foreground px-2 py-0.5 rounded text-xs border border-border transition-colors"
      >
        <Code size={14} />
        <span>Add SQL</span>
      </button>
      <button
        onClick={onAddMarkdown}
        className="flex items-center gap-1.5 hover:bg-muted text-muted-foreground hover:text-foreground px-2 py-0.5 rounded text-xs border border-border transition-colors"
      >
        <FileText size={14} />
        <span>Add Markdown</span>
      </button>
    </div>
  );
};

export default AddCellButton;
