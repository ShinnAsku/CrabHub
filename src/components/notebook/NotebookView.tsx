import { useState, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import { executeQuery } from "@/lib/tauri-commands";

import SqlCell from "./SqlCell";
import MarkdownCell from "./MarkdownCell";
import AddCellButton from "./AddCellButton";
import NotebookToolbar from "./NotebookToolbar";
import NotebookOutline from "./NotebookOutline";
import RunAllSummary from "./RunAllSummary";
import ParamsPanel from "./ParamsPanel";

interface Cell {
  id: string;
  type: "sql" | "markdown";
  content: string;
  name: string;
  executed: boolean;
  result?: any;
  error?: string;
  isRunning?: boolean;
}

interface NotebookViewProps {
  connectionId: string;
  onClose: () => void;
}

// Process cell variables like {{cellName.columnName}}
const processCellVariables = (sql: string, cells: Cell[]): string => {
  let processedSql = sql;
  const variableRegex = /\{\{([^.]+)\.([^}]+)\}\}/g;
  let match;
  
  while ((match = variableRegex.exec(sql)) !== null) {
    const cellName = match[1];
    const columnName = match[2];
    const referencedCell = cells.find(c => c.name === cellName);
    
    if (referencedCell && referencedCell.result && referencedCell.result.rows.length > 0) {
      const colIndex = referencedCell.result.columns.indexOf(columnName);
      if (colIndex !== -1) {
        const values = referencedCell.result.rows.map((row: any[]) => {
          const val = row[colIndex];
          if (typeof val === "string") {
            return `'${val.replace(/'/g, "''")}'`;
          }
          return val;
        });
        const replacement = values.join(", ");
        processedSql = processedSql.replace(match[0], replacement);
      }
    }
  }
  
  return processedSql;
};

const NotebookView: React.FC<NotebookViewProps> = ({ connectionId, onClose }) => {
  const { activeConnectionId } = useAppStore();
  
  const [cells, setCells] = useState<Cell[]>([
    {
      id: "1",
      type: "sql",
      content: "-- Write your SQL here\n-- Use {{cellName.columnName}} to reference results from other cells\nSELECT * FROM table_name LIMIT 10;",
      name: "SQL Cell 1",
      executed: false
    }
  ]);
  const [activeCellId, setActiveCellId] = useState<string>("1");
  const [isRunningAll, setIsRunningAll] = useState<boolean>(false);
  const [runSummary, setRunSummary] = useState<{
    success: boolean;
    executed: number;
    failed: number;
    errors: string[];
  } | null>(null);
  const [showOutline, setShowOutline] = useState<boolean>(true);
  const [showParams, setShowParams] = useState<boolean>(false);
  const [params, setParams] = useState<Record<string, string>>({
    "example": "value"
  });

  const effectiveConnectionId = connectionId || activeConnectionId;

  const addSqlCell = useCallback((afterId?: string) => {
    const newId = Date.now().toString();
    const newCell: Cell = {
      id: newId,
      type: "sql",
      content: "-- Write your SQL here\nSELECT * FROM table_name LIMIT 10;",
      name: `SQL Cell ${cells.length + 1}`,
      executed: false
    };

    if (afterId) {
      const index = cells.findIndex(cell => cell.id === afterId);
      if (index !== -1) {
        setCells(prev => [
          ...prev.slice(0, index + 1),
          newCell,
          ...prev.slice(index + 1)
        ]);
        setActiveCellId(newId);
        return;
      }
    }

    setCells(prev => [...prev, newCell]);
    setActiveCellId(newId);
  }, [cells]);

  const addMarkdownCell = useCallback((afterId?: string) => {
    const newId = Date.now().toString();
    const newCell: Cell = {
      id: newId,
      type: "markdown",
      content: "# Markdown Cell\n\nWrite your markdown here.",
      name: `Markdown Cell ${cells.length + 1}`,
      executed: false
    };

    if (afterId) {
      const index = cells.findIndex(cell => cell.id === afterId);
      if (index !== -1) {
        setCells(prev => [
          ...prev.slice(0, index + 1),
          newCell,
          ...prev.slice(index + 1)
        ]);
        setActiveCellId(newId);
        return;
      }
    }

    setCells(prev => [...prev, newCell]);
    setActiveCellId(newId);
  }, [cells]);

  const updateCellContent = useCallback((id: string, content: string) => {
    setCells(prev => prev.map(cell => 
      cell.id === id ? { ...cell, content } : cell
    ));
  }, []);

  const updateCellName = useCallback((id: string, name: string) => {
    setCells(prev => prev.map(cell => 
      cell.id === id ? { ...cell, name } : cell
    ));
  }, []);

  const deleteCell = useCallback((id: string) => {
    setCells(prev => {
      const filtered = prev.filter(cell => cell.id !== id);
      if (filtered.length === 0) {
        addSqlCell();
      } else if (activeCellId === id && filtered[0]) {
        setActiveCellId(filtered[0].id);
      }
      return filtered;
    });
  }, [addSqlCell, activeCellId]);

  const moveCell = useCallback((id: string, direction: "up" | "down") => {
    setCells(prev => {
      const index = prev.findIndex(cell => cell.id === id);
      if (index === -1) return prev;

      const newIndex = direction === "up" ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= prev.length) return prev;

      const newCells = [...prev];
      if (newCells[index] && newCells[newIndex]) {
        [newCells[index], newCells[newIndex]] = [newCells[newIndex], newCells[index]];
      }
      return newCells;
    });
  }, []);

  const runCell = useCallback(async (cell: Cell) => {
    if (!effectiveConnectionId || cell.type !== "sql") return;

    setCells(prev => prev.map(c => 
      c.id === cell.id ? { ...c, isRunning: true, executed: false, error: undefined } : c
    ));

    try {
      const processedSql = processCellVariables(cell.content, cells);
      const result = await executeQuery(effectiveConnectionId, processedSql);
      
      setCells(prev => prev.map(c => 
        c.id === cell.id ? {
          ...c,
          isRunning: false,
          executed: true,
          result: result
        } : c
      ));
    } catch (error) {
      setCells(prev => prev.map(c => 
        c.id === cell.id ? {
          ...c,
          isRunning: false,
          executed: true,
          error: error instanceof Error ? error.message : String(error)
        } : c
      ));
    }
  }, [effectiveConnectionId, cells]);

  const runAllCells = useCallback(async () => {
    if (!effectiveConnectionId) return;

    setIsRunningAll(true);
    setRunSummary(null);

    let executed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const cell of cells) {
      if (cell.type === "sql") {
        executed++;
        try {
          setCells(prev => prev.map(c => 
            c.id === cell.id ? { ...c, isRunning: true, executed: false, error: undefined } : c
          ));

          const processedSql = processCellVariables(cell.content, cells);
          const result = await executeQuery(effectiveConnectionId, processedSql);
          
          setCells(prev => prev.map(c => 
            c.id === cell.id ? {
              ...c,
              isRunning: false,
              executed: true,
              result: result
            } : c
          ));
        } catch (error) {
          failed++;
          const errorMsg = error instanceof Error ? error.message : String(error);
          errors.push(`${cell.name}: ${errorMsg}`);
          
          setCells(prev => prev.map(c => 
            c.id === cell.id ? {
              ...c,
              isRunning: false,
              executed: true,
              error: errorMsg
            } : c
          ));
        }
      }
    }

    setRunSummary({
      success: failed === 0,
      executed,
      failed,
      errors
    });
    setIsRunningAll(false);
  }, [effectiveConnectionId, cells]);

  const saveNotebook = useCallback(() => {
    const notebookData = {
      cells,
      params,
      version: "1.0"
    };
    const jsonString = JSON.stringify(notebookData, null, 2);
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `notebook_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [cells, params]);

  return (
    <div className="flex flex-col h-full bg-background text-foreground">
      <NotebookToolbar 
        onSave={saveNotebook}
        onRunAll={runAllCells}
        isRunningAll={isRunningAll}
        onClose={onClose}
      />

      <div className="flex flex-1 overflow-hidden">
        {showOutline && (
          <NotebookOutline 
            cells={cells} 
            activeCellId={activeCellId}
            onCellClick={setActiveCellId}
          />
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {runSummary && (
            <RunAllSummary 
              summary={runSummary} 
              onClose={() => setRunSummary(null)} 
            />
          )}

          {cells.map((cell, index) => (
            <div key={cell.id} className="mb-6">
              {cell.type === "sql" ? (
                <SqlCell
                  cell={cell}
                  isActive={activeCellId === cell.id}
                  allCells={cells}
                  onContentChange={content => updateCellContent(cell.id, content)}
                  onNameChange={name => updateCellName(cell.id, name)}
                  onRun={runCell}
                  onDelete={() => deleteCell(cell.id)}
                  onMoveUp={() => moveCell(cell.id, "up")}
                  onMoveDown={() => moveCell(cell.id, "down")}
                  onAddSqlAfter={() => addSqlCell(cell.id)}
                  onAddMarkdownAfter={() => addMarkdownCell(cell.id)}
                />
              ) : (
                <MarkdownCell
                  cell={cell}
                  isActive={activeCellId === cell.id}
                  onContentChange={content => updateCellContent(cell.id, content)}
                  onNameChange={name => updateCellName(cell.id, name)}
                  onDelete={() => deleteCell(cell.id)}
                  onMoveUp={() => moveCell(cell.id, "up")}
                  onMoveDown={() => moveCell(cell.id, "down")}
                  onAddSqlAfter={() => addSqlCell(cell.id)}
                  onAddMarkdownAfter={() => addMarkdownCell(cell.id)}
                />
              )}
              
              {index === cells.length - 1 && (
                <div className="flex justify-center mt-4">
                  <AddCellButton 
                    onAddSql={() => addSqlCell()}
                    onAddMarkdown={() => addMarkdownCell()}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        {showParams && (
          <ParamsPanel 
            params={params}
            onParamsChange={setParams}
          />
        )}
      </div>
    </div>
  );
};

export default NotebookView;
