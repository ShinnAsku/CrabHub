import { useState, useMemo } from "react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  ScatterChart, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { X } from "lucide-react";

type ChartType = "bar" | "line" | "pie" | "scatter";

interface QuickChartPanelProps {
  columns: string[];
  rows: Record<string, unknown>[];
  onClose: () => void;
  defaultXColumn?: string;
  defaultYColumn?: string;
}

function inferChartType(rows: Record<string, unknown>[], xCol: string, yCol: string): ChartType {
  if (!rows.length) return "bar";
  const xVal = rows[0]?.[xCol];
  const yVal = rows[0]?.[yCol];
  const xIsNum = typeof xVal === "number";
  const yIsNum = typeof yVal === "number";
  const xIsDate = typeof xVal === "string" && !isNaN(Date.parse(xVal as string));
  if (xIsNum && yIsNum) return "scatter";
  if (xIsDate && yIsNum) return "line";
  if (!xIsNum && yIsNum) return "bar";
  return "bar";
}

const COLORS = ["#0071e3", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#ec4899"];

export default function QuickChartPanel({
  columns, rows, onClose, defaultXColumn, defaultYColumn,
}: QuickChartPanelProps) {
  const xCol = defaultXColumn ?? columns[0] ?? "";
  const yCol = defaultYColumn ?? columns[1] ?? "";
  const [chartType, setChartType] = useState<ChartType>(
    inferChartType(rows, xCol, yCol)
  );

  const chartData = useMemo(() => {
    if (chartType === "pie") {
      return rows.map(row => ({
        name: String(row[xCol] ?? ""),
        value: Number(row[yCol]) || 0,
      }));
    }
    return rows;
  }, [rows, xCol, yCol, chartType]);

  return (
    <div className="fixed bottom-4 right-4 w-[600px] h-[400px]
      bg-background/95 backdrop-blur-xl rounded-xl
      shadow-[0_4px_6px_rgba(0,0,0,0.04),0_12px_24px_rgba(0,0,0,0.06)]
      border border-border p-4 z-50">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Chart</span>
          <select
            value={chartType}
            onChange={e => setChartType(e.target.value as ChartType)}
            className="text-xs border border-border rounded-md px-2 py-1 bg-background"
          >
            <option value="bar">Bar</option>
            <option value="line">Line</option>
            <option value="pie">Pie</option>
            <option value="scatter">Scatter</option>
          </select>
        </div>
        <button onClick={onClose}
          className="p-1.5 hover:bg-secondary rounded-md transition-colors">
          <X size={16} />
        </button>
      </div>
      <ResponsiveContainer width="100%" height="88%">
        {chartType === "bar" ? (
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={xCol} tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Bar dataKey={yCol} fill={COLORS[0]} radius={[4, 4, 0, 0]} />
          </BarChart>
        ) : chartType === "line" ? (
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={xCol} tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Line type="monotone" dataKey={yCol} stroke={COLORS[0]} strokeWidth={2} />
          </LineChart>
        ) : chartType === "pie" ? (
          <PieChart>
            <Pie data={chartData} dataKey="value" nameKey="name" cx="50%" cy="50%"
              outerRadius={120} label={({ name, value }) => `${name}: ${value}`}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip />
          </PieChart>
        ) : (
          <ScatterChart>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey={xCol} tick={{ fontSize: 12 }} />
            <YAxis dataKey={yCol} tick={{ fontSize: 12 }} />
            <Tooltip />
            <Scatter data={chartData} fill={COLORS[0]} />
          </ScatterChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
