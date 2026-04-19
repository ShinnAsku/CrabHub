import React from "react";
import { Plus, Code, FileText } from "lucide-react";

interface AddCellButtonProps {
  onAddSql: () => void;
  onAddMarkdown: () => void;
}

const AddCellButton: React.FC<AddCellButtonProps> = ({ onAddSql, onAddMarkdown }) => {
  return (
    <div className="flex space-x-2">
      <button
        onClick={onAddSql}
        className="flex items-center space-x-2 bg-card hover:bg-accent text-foreground px-4 py-2 rounded-md border border-border transition-colors"
      >
        <Code className="w-4 h-4" />
        <span>Add SQL Cell</span>
      </button>
      <button
        onClick={onAddMarkdown}
        className="flex items-center space-x-2 bg-card hover:bg-accent text-foreground px-4 py-2 rounded-md border border-border transition-colors"
      >
        <FileText className="w-4 h-4" />
        <span>Add Markdown Cell</span>
      </button>
    </div>
  );
};

export default AddCellButton;