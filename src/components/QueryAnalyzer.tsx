import React, { useState, useCallback, useEffect } from 'react';
import { useAppStore, useHistoryStore } from "@/stores/app-store";
import type { SlowQueryEntry } from "@/types";
import { executeQuery } from '@/lib/tauri-commands';
import { t } from '@/lib/i18n';
import {
  Play,
  Loader2,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  Clock,
  BarChart3,
  Trash2,
  RotateCcw,
} from 'lucide-react';

// ===== Types =====

export interface ExplainNode {
  id: string;
  type: string;
  relation?: string;
  alias?: string;
  schema?: string;
  cost?: number;
  rows?: number;
  width?: number;
  actualTime?: number;
  actualRows?: number;
  actualLoops?: number;
  extra?: string;
  filter?: string;
  indexCond?: string;
  joinFilter?: string;
  hashCond?: string;
  mergeCond?: string;
  recheckCond?: string;
  children?: ExplainNode[];
  isParallelAware?: boolean;
  workers?: number[];
  planner?: string;
  plannerTime?: number;
}

export interface SlowQuery {
  id: string;
  sql: string;
  executionTime: number;
  timestamp: number;
  connectionName: string;
  connectionId: string;
}

interface QueryAnalyzerProps {
  connectionId: string | null;
  dbType: string;
  onInsertQuery?: (sql: string) => void;
  initialSql?: string;
  embedded?: boolean;
}

// ===== EXPLAIN Parsers =====

function generateNodeId(): string {
  return Math.random().toString(36).substring(2, 9);
}

function parsePostgresExplain(data: any): ExplainNode | null {
  // PostgreSQL EXPLAIN (FORMAT JSON) returns:
  // [{ Plan: { ... } }] or [{ "QUERY PLAN": { ... } }]
  try {
    let plan = null;
    if (Array.isArray(data)) {
      const first = data[0];
      plan = first?.Plan || first?.['QUERY PLAN'] || first;
    } else if (data?.Plan) {
      plan = data.Plan;
    } else if (data?.['QUERY PLAN']) {
      plan = data['QUERY PLAN'];
    } else {
      plan = data;
    }

    if (!plan || typeof plan !== 'object') return null;

    return transformPostgresNode(plan);
  } catch {
    return null;
  }
}

function transformPostgresNode(node: any, depth: number = 0): ExplainNode {
  const result: ExplainNode = {
    id: generateNodeId(),
    type: node['Node Type'] || node['node_type'] || 'Unknown',
    relation: node['Relation Name'] || node['relation_name'],
    alias: node['Alias'] || node['alias'],
    schema: node['Schema'] || node['schema'],
    cost: node['Total Cost'] ?? node['total_cost'] ?? undefined,
    rows: node['Plan Rows'] ?? node['plan_rows'] ?? undefined,
    width: node['Plan Width'] ?? node['plan_width'] ?? undefined,
    actualTime: node['Actual Total Time'] ?? node['actual_total_time'] ?? undefined,
    actualRows: node['Actual Rows'] ?? node['actual_rows'] ?? undefined,
    actualLoops: node['Actual Loops'] ?? node['actual_loops'] ?? undefined,
    isParallelAware: node['Parallel Aware'] ?? false,
    workers: node['Workers'] ?? node['Workers Planned'] ?? undefined,
    planner: node['Planner'] ?? undefined,
    plannerTime: node['Planner Time'] ?? undefined,
  };

  // Build extra info
  const extras: string[] = [];
  if (node['Filter']) extras.push(`Filter: ${node['Filter']}`);
  if (node['Index Cond']) extras.push(`Index Cond: ${node['Index Cond']}`);
  if (node['Join Filter']) extras.push(`Join Filter: ${node['Join Filter']}`);
  if (node['Hash Cond']) extras.push(`Hash Cond: ${node['Hash Cond']}`);
  if (node['Merge Cond']) extras.push(`Merge Cond: ${node['Merge Cond']}`);
  if (node['Recheck Cond']) extras.push(`Recheck Cond: ${node['Recheck Cond']}`);
  if (node['One-Time Filter']) extras.push(`One-Time Filter: ${node['One-Time Filter']}`);
  if (node['Index Name']) extras.push(`Index: ${node['Index Name']}`);
  if (node['Sort Key']) extras.push(`Sort Key: ${node['Sort Key']}`);
  if (node['Sort Method']) extras.push(`Sort Method: ${node['Sort Method']}`);
  if (node['Group Key']) extras.push(`Group Key: ${node['Group Key']}`);
  if (node['Hash Buckets']) extras.push(`Hash Buckets: ${node['Hash Buckets']}`);
  if (node['Batches']) extras.push(`Batches: ${node['Batches']}`);
  if (node['Original Hash Buckets']) extras.push(`Original Hash Buckets: ${node['Original Hash Buckets']}`);
  if (node['Shared Hit Blocks'] !== undefined) {
    extras.push(`Shared Hit: ${node['Shared Hit Blocks']}, Read: ${node['Shared Read Blocks'] ?? 0}, Dirtied: ${node['Shared Dirtied Blocks'] ?? 0}, Written: ${node['Shared Written Blocks'] ?? 0}`);
  }
  if (node['Local Hit Blocks'] !== undefined) {
    extras.push(`Local Hit: ${node['Local Hit Blocks']}, Read: ${node['Local Read Blocks'] ?? 0}`);
  }
  if (node['Temp Read Blocks'] !== undefined) {
    extras.push(`Temp Read: ${node['Temp Read Blocks']}, Written: ${node['Temp Written Blocks'] ?? 0}`);
  }
  if (node['Workers'] !== undefined && Array.isArray(node['Workers'])) {
    extras.push(`Workers: ${node['Workers'].length}`);
  }

  result.extra = extras.length > 0 ? extras.join('\n') : undefined;

  // Children
  if (node['Plans'] && Array.isArray(node['Plans'])) {
    result.children = node['Plans'].map((child: any) => transformPostgresNode(child, depth + 1));
  }

  return result;
}

function parseMysqlExplain(data: any): ExplainNode | null {
  // MySQL EXPLAIN FORMAT=JSON returns a JSON object
  try {
    if (!data || typeof data !== 'object') return null;

    // MySQL explain has "query_block" as root
    const root = data.query_block || data;
    return transformMysqlNode(root);
  } catch {
    return null;
  }
}

function transformMysqlNode(node: any, depth: number = 0): ExplainNode {
  const result: ExplainNode = {
    id: generateNodeId(),
    type: node['table_type'] || node['type'] || node['access_type'] || 'Unknown',
    relation: node['table'] || node['table_name'],
    extra: node['extra_info'] || node['Extra'] || undefined,
    rows: node['rows'] ?? node['rows_examined_per_scan'] ?? undefined,
    cost: node['cost_info']?.['query_cost'] ?? undefined,
  };

  const extras: string[] = [];
  if (node['key']) extras.push(`Key: ${node['key']}`);
  if (node['key_length']) extras.push(`Key Length: ${node['key_length']}`);
  if (node['possible_keys']) extras.push(`Possible Keys: ${node['possible_keys']}`);
  if (node['ref']) extras.push(`Ref: ${node['ref']}`);
  if (node['rows_examined_per_scan']) extras.push(`Rows Examined: ${node['rows_examined_per_scan']}`);
  if (node['rows_produced_per_join']) extras.push(`Rows Produced: ${node['rows_produced_per_join']}`);
  if (node['filtered']) extras.push(`Filtered: ${node['filtered']}%`);
  if (node['using_temporary_table']) extras.push('Using Temporary Table');
  if (node['using_filesort']) extras.push('Using Filesort');
  if (node['cost_info']?.['read_cost'] !== undefined) {
    extras.push(`Read Cost: ${node['cost_info']['read_cost']}`);
  }
  if (node['cost_info']?.['eval_cost'] !== undefined) {
    extras.push(`Eval Cost: ${node['cost_info']['eval_cost']}`);
  }
  if (node['cost_info']?.['prefix_cost'] !== undefined) {
    extras.push(`Prefix Cost: ${node['cost_info']['prefix_cost']}`);
  }
  if (node['used_columns']) extras.push(`Used Columns: ${node['used_columns']}`);

  if (extras.length > 0) {
    result.extra = result.extra ? result.extra + '\n' + extras.join('\n') : extras.join('\n');
  }

  // MySQL children
  const children: ExplainNode[] = [];
  if (node['nested_loop']) {
    if (Array.isArray(node['nested_loop'])) {
      node['nested_loop'].forEach((child: any) => {
        children.push(transformMysqlNode(child, depth + 1));
      });
    } else {
      children.push(transformMysqlNode(node['nested_loop'], depth + 1));
    }
  }
  if (node['ordering_operation']) {
    children.push(transformMysqlNode(node['ordering_operation'], depth + 1));
  }
  if (node['grouping_operation']) {
    children.push(transformMysqlNode(node['grouping_operation'], depth + 1));
  }
  if (node['subqueries']) {
    if (Array.isArray(node['subqueries'])) {
      node['subqueries'].forEach((sq: any) => {
        children.push(transformMysqlNode(sq, depth + 1));
      });
    }
  }
  if (node['query_specifications']) {
    if (Array.isArray(node['query_specifications'])) {
      node['query_specifications'].forEach((qs: any) => {
        children.push(transformMysqlNode(qs, depth + 1));
      });
    }
  }

  if (children.length > 0) {
    result.children = children;
  }

  return result;
}

function parseSqliteExplain(text: string): ExplainNode | null {
  // SQLite EXPLAIN QUERY PLAN returns text like:
  // SCAN TABLE t1
  // SEARCH TABLE t2 USING INDEX idx_t2_x (x=?)
  // USE TEMP B-TREE FOR ORDER BY
  try {
    const lines = text.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    const root: ExplainNode = {
      id: generateNodeId(),
      type: 'Query Plan',
      children: [],
    };

    for (const line of lines) {
      const trimmed = line.trim();
      const indent = line.search(/\S/);
      const node = parseSqliteLine(trimmed);
      if (node) {
        insertAtIndent(root, node, Math.floor(indent / 4));
      }
    }

    return root;
  } catch {
    return null;
  }
}

function parseSqliteLine(line: string): ExplainNode {
  let type = 'Unknown';
  let relation: string | undefined;
  let extra: string | undefined;

  const upper = line.toUpperCase();

  if (upper.startsWith('SCAN TABLE')) {
    type = 'Seq Scan';
    const match = line.match(/SCAN TABLE (\S+)/i);
    relation = match?.[1];
    const rest = line.substring(match?.[0]?.length || 0).trim();
    if (rest) extra = rest;
  } else if (upper.startsWith('SEARCH TABLE')) {
    type = 'Index Scan';
    const match = line.match(/SEARCH TABLE (\S+)/i);
    relation = match?.[1];
    const idxMatch = line.match(/USING (?:INDEX|COVERING INDEX) (\S+)/i);
    if (idxMatch) extra = `Index: ${idxMatch[1]}`;
    const condMatch = line.match(/\((.+)\)\s*$/);
    if (condMatch) extra = extra ? extra + `\nCond: ${condMatch[1]}` : `Cond: ${condMatch[1]}`;
  } else if (upper.startsWith('USE TEMP B-TREE')) {
    type = 'Sort';
    const rest = line.replace(/USE TEMP B-TREE FOR\s*/i, '').trim();
    extra = rest || 'Using temporary B-Tree';
  } else if (upper.startsWith('USE')) {
    type = 'Sort';
    extra = line.replace(/^USE\s*/i, '').trim();
  } else if (upper.startsWith('COMPOUND SUBQUERIES')) {
    type = 'Compound';
    extra = line.replace(/COMPOUND SUBQUERIES\s*/i, '').trim();
  } else if (upper.startsWith('CORRELATED SCALAR SUBQUERY')) {
    type = 'Subquery';
    relation = line.match(/SCALAR SUBQUERY (\d+)/i)?.[1];
    extra = 'Correlated';
  } else if (upper.startsWith('CO-ROUTINE')) {
    type = 'Co-routine';
    extra = line.replace(/CO-ROUTINE\s*/i, '').trim();
  } else if (upper.startsWith('MATERIALIZE')) {
    type = 'Materialize';
    extra = line.replace(/MATERIALIZE\s*/i, '').trim();
  } else if (upper.includes('LIST SUBQUERY')) {
    type = 'List Subquery';
    extra = line.replace(/^.*LIST SUBQUERY\s*/i, '').trim();
  } else {
    type = line;
  }

  return {
    id: generateNodeId(),
    type,
    relation,
    extra,
  };
}

function insertAtIndent(root: ExplainNode, node: ExplainNode, targetDepth: number) {
  if (targetDepth <= 0) {
    root.children = root.children || [];
    root.children.push(node);
    return;
  }

  if (!root.children || root.children.length === 0) {
    root.children = [node];
    return;
  }

  // Find the last child at depth-1 and insert there
  const lastChild = root.children[root.children.length - 1];
  if (lastChild) {
    insertAtIndent(lastChild, node, targetDepth - 1);
  }
}

function parseClickHouseExplain(data: any): ExplainNode | null {
  // ClickHouse EXPLAIN PLAN = JSON returns JSON
  // ClickHouse EXPLAIN PLAN returns text
  try {
    if (typeof data === 'string') {
      return parseClickHouseText(data);
    }
    if (typeof data === 'object' && data !== null) {
      return transformClickHouseNode(data);
    }
    return null;
  } catch {
    return null;
  }
}

function transformClickHouseNode(node: any): ExplainNode {
  const result: ExplainNode = {
    id: generateNodeId(),
    type: node['type'] || node['Plan'] || 'Unknown',
    extra: node['description'] || node['details'] || undefined,
  };

  const extras: string[] = [];
  if (node['processors']) extras.push(`Processors: ${node['processors']}`);
  if (node['estimates']) extras.push(`Estimates: ${JSON.stringify(node['estimates'])}`);
  if (node['execution_time']) {
    result.actualTime = parseFloat(node['execution_time']) || undefined;
  }
  if (node['rows']) result.rows = node['rows'];
  if (node['bytes']) extras.push(`Bytes: ${node['bytes']}`);

  if (extras.length > 0) {
    result.extra = result.extra ? result.extra + '\n' + extras.join('\n') : extras.join('\n');
  }

  if (node['plans'] && Array.isArray(node['plans'])) {
    result.children = node['plans'].map((child: any) => transformClickHouseNode(child));
  }

  return result;
}

function parseClickHouseText(text: string): ExplainNode | null {
  try {
    const lines = text.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    const root: ExplainNode = {
      id: generateNodeId(),
      type: 'Query Plan',
      children: [],
    };

    for (const line of lines) {
      const trimmed = line.trim();
      // ClickHouse text format: "0: Expression ..."
      const match = trimmed.match(/^(\d+):\s*(.+)$/);
      if (match && match[2]) {
        const desc = match[2];
        root.children = root.children || [];
        const node: ExplainNode = {
          id: generateNodeId(),
          type: desc.split(/\s+/)[0] || 'Unknown',
          extra: desc,
        };
        root.children.push(node);
      }
    }

    return root;
  } catch {
    return null;
  }
}

function parseMssqlExplain(text: string): ExplainNode | null {
  // MSSQL SET SHOWPLAN_TEXT returns text like:
  // |--Hash Match(Inner Join, HASH:([t1].[id])=([t2].[id]))
  // |   |--Table Scan(OBJECT:([dbo].[t1]))
  // |   |--Index Scan(OBJECT:([dbo].[idx_t2_id]))
  try {
    const lines = text.trim().split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    const root: ExplainNode = {
      id: generateNodeId(),
      type: 'Query Plan',
      children: [],
    };

    for (const line of lines) {
      const trimmed = line.trim();
      const indent = (line.match(/^[\s|]*/)?.[0]?.length || 0);
      const node = parseMssqlLine(trimmed);
      if (node) {
        insertAtIndent(root, node, Math.floor(indent / 4));
      }
    }

    return root;
  } catch {
    return null;
  }
}

function parseMssqlLine(line: string): ExplainNode {
  let type = 'Unknown';
  let extra: string | undefined;
  let relation: string | undefined;

  // Remove leading |-- or |
  const cleaned = line.replace(/^[\s|]*--?\s*/, '');

  if (cleaned.startsWith('Table Scan')) {
    type = 'Table Scan';
    const objMatch = cleaned.match(/OBJECT:\s*\(\[([^\]]+)\]\.\[([^\]]+)\]\)/i);
    if (objMatch) {
      relation = objMatch[2];
      extra = `Schema: ${objMatch[1]}`;
    }
  } else if (cleaned.startsWith('Index Scan')) {
    type = 'Index Scan';
    const objMatch = cleaned.match(/OBJECT:\s*\(\[([^\]]+)\]\.\[([^\]]+)\]\.\[([^\]]+)\]\)/i);
    if (objMatch) {
      relation = objMatch[2];
      extra = `Schema: ${objMatch[1]}, Index: ${objMatch[3]}`;
    }
  } else if (cleaned.startsWith('Clustered Index Scan')) {
    type = 'Clustered Index Scan';
    const objMatch = cleaned.match(/OBJECT:\s*\(\[([^\]]+)\]\.\[([^\]]+)\]\.\[([^\]]+)\]\)/i);
    if (objMatch) {
      relation = objMatch[2];
      extra = `Schema: ${objMatch[1]}, Index: ${objMatch[3]}`;
    }
  } else if (cleaned.startsWith('Hash Match')) {
    type = 'Hash Match';
    const innerMatch = cleaned.match(/Hash Match\(([^)]+)\)/i);
    if (innerMatch) extra = innerMatch[1];
  } else if (cleaned.startsWith('Nested Loops')) {
    type = 'Nested Loops';
    const innerMatch = cleaned.match(/Nested Loops\(([^)]+)\)/i);
    if (innerMatch) extra = innerMatch[1];
  } else if (cleaned.startsWith('Merge Join')) {
    type = 'Merge Join';
    const innerMatch = cleaned.match(/Merge Join\(([^)]+)\)/i);
    if (innerMatch) extra = innerMatch[1];
  } else if (cleaned.startsWith('Compute Scalar')) {
    type = 'Compute Scalar';
    const defMatch = cleaned.match(/DEFINE:\s*\((.+)\)/i);
    if (defMatch) extra = `DEFINE: ${defMatch[1]}`;
  } else if (cleaned.startsWith('Filter')) {
    type = 'Filter';
    const whereMatch = cleaned.match(/WHERE:\s*(.+)$/i);
    if (whereMatch) extra = `WHERE: ${whereMatch[1]}`;
  } else if (cleaned.startsWith('Sort')) {
    type = 'Sort';
    const orderByMatch = cleaned.match(/ORDER BY:\s*(.+)$/i);
    if (orderByMatch) extra = `ORDER BY: ${orderByMatch[1]}`;
  } else if (cleaned.startsWith('Top')) {
    type = 'Top';
    const topMatch = cleaned.match(/TOP\s*\((.+)\)/i);
    if (topMatch) extra = topMatch[1];
  } else if (cleaned.startsWith('Stream Aggregate')) {
    type = 'Stream Aggregate';
    const groupMatch = cleaned.match(/GROUP BY:\s*(.+)$/i);
    if (groupMatch) extra = `GROUP BY: ${groupMatch[1]}`;
  } else if (cleaned.startsWith('Hash Aggregate')) {
    type = 'Hash Aggregate';
    const groupMatch = cleaned.match(/GROUP BY:\s*(.+)$/i);
    if (groupMatch) extra = `GROUP BY: ${groupMatch[1]}`;
  } else {
    type = cleaned.split('(')[0]?.trim() || 'Unknown';
    extra = cleaned;
  }

  return {
    id: generateNodeId(),
    type,
    relation,
    extra,
  };
}

// ===== Cost Analysis =====

function getMaxCost(node: ExplainNode): number {
  let max = node.actualTime ?? node.cost ?? 0;
  if (node.children) {
    for (const child of node.children) {
      max = Math.max(max, getMaxCost(child));
    }
  }
  return max;
}

function getTotalCost(node: ExplainNode): number {
  let total = node.actualTime ?? node.cost ?? 0;
  if (node.children) {
    for (const child of node.children) {
      total += getTotalCost(child);
    }
  }
  return total;
}

function isExpensiveOperation(type: string): boolean {
  const expensive = [
    'seq scan', 'sequential scan', 'table scan',
    'nested loop', 'nested loops',
    'sort', 'merge join',
    'bitmap heap scan',
    'subquery scan',
    'materialize',
    'cte scan',
    'function scan',
    'values scan',
    'clustered index scan',
  ];
  const lower = type.toLowerCase();
  return expensive.some(op => lower.includes(op));
}

function getCostLevel(node: ExplainNode, maxCost: number): 'low' | 'medium' | 'high' {
  const value = node.actualTime ?? node.cost ?? 0;
  if (maxCost === 0) return 'low';
  const ratio = value / maxCost;
  if (ratio > 0.6) return 'high';
  if (ratio > 0.3) return 'medium';
  return 'low';
}

// ===== Plan Node Component =====

function PlanNodeView({
  node,
  depth,
  maxCost,
}: {
  node: ExplainNode;
  depth: number;
  maxCost: number;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(depth < 3);
  const hasChildren = node.children && node.children.length > 0;
  const costLevel = getCostLevel(node, maxCost);
  const isExpensive = isExpensiveOperation(node.type);
  const costValue = node.actualTime ?? node.cost;

  const costColorMap = {
    low: 'border-green-500/40 bg-green-500/5',
    medium: 'border-yellow-500/40 bg-yellow-500/5',
    high: 'border-red-500/40 bg-red-500/5',
  };

  const costTextMap = {
    low: 'text-green-400',
    medium: 'text-yellow-400',
    high: 'text-red-400',
  };

  const costBarColorMap = {
    low: 'bg-green-500',
    medium: 'bg-yellow-500',
    high: 'bg-red-500',
  };

  const costPercent = maxCost > 0 && costValue ? Math.min((costValue / maxCost) * 100, 100) : 0;

  // Get node icon based on type
  const getNodeIcon = (type: string) => {
    const lower = type.toLowerCase();
    if (lower.includes('scan') || lower.includes('table')) {
      return '📋';
    } else if (lower.includes('index')) {
      return '🔍';
    } else if (lower.includes('join')) {
      return '🔄';
    } else if (lower.includes('sort')) {
      return '📊';
    } else if (lower.includes('aggregate') || lower.includes('group')) {
      return '🔢';
    } else if (lower.includes('filter')) {
      return '🎯';
    } else if (lower.includes('subquery')) {
      return '📦';
    } else if (lower.includes('materialize')) {
      return '💾';
    } else {
      return '📝';
    }
  };

  return (
    <div style={{ marginLeft: depth > 0 ? 16 : 0 }}>
      <div
        className={`rounded border ${isExpensive ? costColorMap[costLevel] : 'border-border'} transition-colors shadow-sm hover:shadow-md`}
      >
        {/* Node header */}
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer select-none"
          onClick={() => hasChildren && setExpanded(!expanded)}
        >
          {/* Expand/Collapse */}
          <span className="w-3.5 h-3.5 flex items-center justify-center shrink-0">
            {hasChildren ? (
              expanded ? <ChevronDown size={12} className="text-muted-foreground" /> : <ChevronRight size={12} className="text-muted-foreground" />
            ) : (
              <span className="w-1 h-1 rounded-full bg-muted-foreground/40" />
            )}
          </span>

          {/* Node icon */}
          <span className="text-sm shrink-0">
            {getNodeIcon(node.type)}
          </span>

          {/* Type icon */}
          {isExpensive && (
            <AlertTriangle size={12} className="text-yellow-500 shrink-0" />
          )}

          {/* Node type */}
          <span className="text-xs font-mono font-medium text-foreground shrink-0">
            {node.type}
          </span>

          {/* Relation */}
          {node.relation && (
            <span className="text-xs text-muted-foreground">
              on <span className="font-mono">{node.relation}</span>
            </span>
          )}

          {/* Alias */}
          {node.alias && node.alias !== node.relation && (
            <span className="text-[10px] px-1 py-0 rounded bg-muted text-muted-foreground">
              {node.alias}
            </span>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Metrics */}
          <div className="flex items-center gap-3 shrink-0">
            {node.actualTime !== undefined && (
              <span className={`text-[10px] font-mono ${costTextMap[costLevel]}`} title={t('analyzer.actualTime')}>
                <Clock size={10} className="inline mr-0.5" />
                {node.actualTime.toFixed(2)}ms
              </span>
            )}
            {node.actualRows !== undefined && (
              <span className="text-[10px] font-mono text-muted-foreground" title={t('analyzer.rows')}>
                {node.actualRows.toLocaleString()} {t('common.rows').toLowerCase()}
              </span>
            )}
            {node.actualLoops !== undefined && node.actualLoops > 1 && (
              <span className="text-[10px] font-mono text-muted-foreground">
                x{node.actualLoops}
              </span>
            )}
            {node.cost !== undefined && node.actualTime === undefined && (
              <span className={`text-[10px] font-mono ${costTextMap[costLevel]}`} title={t('analyzer.cost')}>
                cost: {node.cost.toFixed(2)}
              </span>
            )}
            {node.rows !== undefined && node.actualRows === undefined && (
              <span className="text-[10px] font-mono text-muted-foreground">
                ~{node.rows.toLocaleString()} {t('common.rows').toLowerCase()}
              </span>
            )}
          </div>
        </div>

        {/* Cost bar */}
        {costPercent > 0 && (
          <div className="px-2.5 pb-1">
            <div className="flex items-center gap-2">
              <div className="flex-1 h-0.5 bg-muted rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${costBarColorMap[costLevel]} transition-all duration-500 ease-in-out`}
                  style={{ width: `${costPercent}%` }}
                />
              </div>
              <span className="text-[9px] font-mono text-muted-foreground shrink-0 min-w-[35px] text-right">
                {costPercent.toFixed(0)}%
              </span>
            </div>
          </div>
        )}

        {/* Extra info */}
        {node.extra && expanded && (
          <div className="px-2.5 pb-1.5">
            <pre className="text-[10px] font-mono text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {node.extra}
            </pre>
          </div>
        )}
      </div>

      {/* Children */}
      {hasChildren && expanded && (
        <div className="mt-0.5">
          {/* Connection line */}
          {depth > 0 && (
            <div className="relative h-2.5">
              <div className="absolute left-7 top-0 bottom-0 w-px bg-border" />
            </div>
          )}
          {node.children!.map((child, index) => (
            <React.Fragment key={child.id}>
              {index > 0 && depth > 0 && (
                <div className="relative h-2.5">
                  <div className="absolute left-7 top-0 bottom-0 w-px bg-border" />
                </div>
              )}
              <PlanNodeView
                node={child}
                depth={depth + 1}
                maxCost={maxCost}
              />
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Query Statistics =====

function QueryStatistics() {
  const { queryHistory } = useAppStore();

  const totalQueries = queryHistory.length;
  const successfulQueries = queryHistory.filter(q => !q.error).length;
  const failedQueries = totalQueries - successfulQueries;

  const executionTimes = queryHistory.map(q => q.duration).filter(t => t > 0);
  const avgTime = executionTimes.length > 0
    ? executionTimes.reduce((a, b) => a + b, 0) / executionTimes.length
    : 0;

  const maxTime = executionTimes.length > 0 ? Math.max(...executionTimes) : 0;

  // Queries per minute (last 5 minutes)
  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;
  const recentQueries = queryHistory.filter(q => new Date(q.timestamp).getTime() > fiveMinAgo);
  const qpm = recentQueries.length / 5;

  // Top 5 slowest queries
  const slowest = [...queryHistory]
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 5);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-4 gap-2">
        <StatCard label={t('analyzer.totalQueries')} value={String(totalQueries)} />
        <StatCard label={t('analyzer.avgTime')} value={`${avgTime.toFixed(0)}ms`} />
        <StatCard label={t('analyzer.maxTime')} value={`${maxTime.toFixed(0)}ms`} />
        <StatCard label={t('analyzer.qpm')} value={qpm.toFixed(1)} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatCard label={t('analyzer.successful')} value={String(successfulQueries)} color="green" />
        <StatCard label={t('analyzer.failed')} value={String(failedQueries)} color="red" />
      </div>

      {slowest.length > 0 && (
        <div>
          <div className="text-[10px] font-medium text-muted-foreground mb-1.5 uppercase tracking-wider">
            {t('analyzer.slowestQueries')}
          </div>
          <div className="space-y-1">
            {slowest.map((q) => (
              <div
                key={q.id}
                className="flex items-center gap-2 px-2 py-1 rounded bg-muted/50 text-[10px]"
              >
                <span className="font-mono text-red-400 shrink-0">
                  {q.duration.toFixed(0)}ms
                </span>
                <span className="font-mono text-foreground truncate flex-1">
                  {q.sql.substring(0, 80)}
                </span>
                <span className="text-muted-foreground shrink-0">
                  {new Date(q.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: 'green' | 'red';
}) {
  const colorMap = {
    green: 'text-green-400',
    red: 'text-red-400',
    default: 'text-foreground',
  };
  const valueColor = colorMap[color || 'default'] || colorMap.default;

  return (
    <div className="px-2.5 py-2 rounded border border-border bg-background">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-sm font-mono font-semibold ${valueColor}`}>{value}</div>
    </div>
  );
}

// ===== Main Component =====

export default function QueryAnalyzer({
  connectionId,
  dbType,
  onInsertQuery,
  initialSql,
  embedded,
}: QueryAnalyzerProps) {
  const { tabs, activeTabId, slowQueryLog, slowQueryThreshold, clearSlowQueries, setSlowQueryThreshold } = useAppStore();
  const [sql, setSql] = useState(initialSql || '');
  const [plan, setPlan] = useState<ExplainNode | null>(null);
  const [rawOutput, setRawOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<'plan' | 'raw' | 'stats' | 'slowlog'>('plan');
  const [maxCost, setMaxCost] = useState(1);

  // Sync SQL from active tab
  useEffect(() => {
    if (embedded && activeTabId) {
      const tab = tabs.find(t => t.id === activeTabId);
      if (tab && tab.type === 'query' && tab.content) {
        setSql(tab.content);
      }
    }
  }, [embedded, activeTabId, tabs]);

  const runExplain = useCallback(async () => {
    if (!connectionId || !sql.trim()) return;

    setLoading(true);
    setError(null);
    setPlan(null);
    setRawOutput('');

    try {
      let explainSql: string;
      switch (dbType) {
        case 'postgresql':
        case 'gaussdb':
        case 'opengauss':
          explainSql = `EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${sql}`;
          break;
        case 'mysql':
          explainSql = `EXPLAIN FORMAT=JSON ${sql}`;
          break;
        case 'sqlite':
          explainSql = `EXPLAIN QUERY PLAN ${sql}`;
          break;
        case 'clickhouse':
          explainSql = `EXPLAIN PLAN = JSON ${sql}`;
          break;
        case 'mssql':
          explainSql = `SET SHOWPLAN_TEXT ON;\n${sql}`;
          break;
        default:
          explainSql = `EXPLAIN ${sql}`;
      }

      const result = await executeQuery(connectionId, explainSql);

      if (result.rows.length > 0) {
        const firstRow = result.rows[0];
        if (!firstRow) {
          setRawOutput(t('analyzer.noPlanData'));
          setActiveView('raw');
        } else {
          const planText = (Object.values(firstRow)[0] as string) || '';

        setRawOutput(planText);

        // Try to parse based on database type
        let parsed: ExplainNode | null = null;

        try {
          const jsonData = JSON.parse(planText);

          switch (dbType) {
            case 'postgresql':
            case 'gaussdb':
            case 'opengauss':
              parsed = parsePostgresExplain(jsonData);
              break;
            case 'mysql':
              parsed = parseMysqlExplain(jsonData);
              break;
            case 'clickhouse':
              parsed = parseClickHouseExplain(jsonData);
              break;
            default:
              // Try all parsers
              parsed = parsePostgresExplain(jsonData) || parseMysqlExplain(jsonData) || parseClickHouseExplain(jsonData);
          }
        } catch {
          // Not JSON, try text parsers
          switch (dbType) {
            case 'sqlite':
              parsed = parseSqliteExplain(planText);
              break;
            case 'mssql':
              parsed = parseMssqlExplain(planText);
              break;
            case 'clickhouse':
              parsed = parseClickHouseExplain(planText);
              break;
            default:
              // Try text parsers as fallback
              parsed = parseSqliteExplain(planText) || parseMssqlExplain(planText);
          }
        }

        if (parsed) {
          setPlan(parsed);
          setMaxCost(getMaxCost(parsed));
          setActiveView('plan');
        } else {
          setActiveView('raw');
        }
        }
      } else {
        setRawOutput(t('analyzer.noPlanData'));
        setActiveView('raw');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setRawOutput(`Error: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [connectionId, sql, dbType]);

  const handleRerunSlowQuery = useCallback((query: SlowQueryEntry) => {
    setSql(query.sql);
    if (onInsertQuery) {
      onInsertQuery(query.sql);
    }
  }, [onInsertQuery]);

  const handleDeleteSlowQuery = useCallback((id: string) => {
    const { slowQueryLog: current } = useHistoryStore.getState();
    const updated = current.filter(q => q.id !== id);
    try {
      localStorage.setItem('crabhub-slow-queries', JSON.stringify(updated));
    } catch {}
    useHistoryStore.setState({ slowQueryLog: updated });
  }, []);

  const handleClearSlowQueries = useCallback(() => {
    clearSlowQueries();
  }, [clearSlowQueries]);

  const handleThresholdChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    if (!isNaN(val) && val >= 0) {
      setSlowQueryThreshold(val);
    }
  }, [setSlowQueryThreshold]);

  const totalCost = plan ? getTotalCost(plan) : 0;

  return (
    <div className="flex flex-col h-full">
      {/* SQL input area */}
      <div className="p-3 border-b border-border shrink-0">
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          placeholder={t('analyzer.inputPlaceholder')}
          className="w-full h-20 bg-muted/50 rounded p-2 text-sm font-mono resize-none border border-border focus:border-[hsl(var(--tab-active))] outline-none text-foreground"
          onKeyDown={(e) => {
            if (e.ctrlKey && e.key === 'Enter') {
              e.preventDefault();
              runExplain();
            }
          }}
        />
        <div className="flex items-center justify-between mt-2">
          <div className="flex items-center gap-2">
            <button
              onClick={runExplain}
              disabled={loading || !sql.trim() || !connectionId}
              className="flex items-center gap-1.5 px-3 py-1 text-xs bg-[hsl(var(--tab-active))] text-white rounded hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
              {t('analyzer.runExplain')}
            </button>
            {plan && (
              <span className="text-[10px] text-muted-foreground">
                {t('analyzer.totalCost')}: {totalCost.toFixed(2)}
              </span>
            )}
          </div>
          <span className="text-[10px] text-muted-foreground">
            Ctrl+Enter
          </span>
        </div>
      </div>

      {/* View tabs */}
      <div className="flex items-center gap-0 px-3 border-b border-border shrink-0">
        {([
          { key: 'plan', label: t('analyzer.executionPlan') },
          { key: 'raw', label: t('analyzer.rawOutput') },
          { key: 'stats', label: t('analyzer.statistics') },
          { key: 'slowlog', label: t('analyzer.slowQueryLog') },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveView(key)}
            className={`px-2.5 py-1.5 text-xs transition-colors ${
              activeView === key
                ? 'text-foreground border-b-2 border-[hsl(var(--tab-active))]'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
            {key === 'slowlog' && slowQueryLog.length > 0 && (
              <span className="ml-1 px-1 py-0 text-[9px] rounded-full bg-red-500/20 text-red-400">
                {slowQueryLog.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {error && (
          <div className="p-3 text-xs text-destructive bg-destructive/5 border-b border-destructive/20">
            {error}
          </div>
        )}

        {activeView === 'plan' && (
          plan ? (
            <div className="p-3 space-y-0.5">
              <PlanNodeView node={plan} depth={0} maxCost={maxCost} />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
              <BarChart3 size={32} className="opacity-20" />
              <p className="text-xs">{t('analyzer.placeholder')}</p>
            </div>
          )
        )}

        {activeView === 'raw' && (
          rawOutput ? (
            <pre className="p-3 text-xs font-mono whitespace-pre-wrap text-foreground">
              {rawOutput}
            </pre>
          ) : (
            <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
              {t('analyzer.noRawData')}
            </div>
          )
        )}

        {activeView === 'stats' && (
          <div className="p-3">
            <QueryStatistics />
          </div>
        )}

        {activeView === 'slowlog' && (
          <div className="flex flex-col h-full">
            {/* Threshold setting */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
              <span className="text-[10px] text-muted-foreground">{t('analyzer.threshold')}:</span>
              <input
                type="number"
                value={slowQueryThreshold}
                onChange={handleThresholdChange}
                className="w-20 px-1.5 py-0.5 text-xs bg-muted border border-border rounded outline-none focus:border-[hsl(var(--tab-active))] text-foreground"
                min={0}
                step={100}
              />
              <span className="text-[10px] text-muted-foreground">ms</span>
              <div className="flex-1" />
              <button
                onClick={handleClearSlowQueries}
                disabled={slowQueryLog.length === 0}
                className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted rounded transition-colors disabled:opacity-40"
              >
                <Trash2 size={10} />
                {t('analyzer.clearLog')}
              </button>
            </div>

            {/* Slow query list */}
            <div className="flex-1 overflow-auto">
              {slowQueryLog.length === 0 ? (
                <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                  {t('analyzer.noSlowQueries')}
                </div>
              ) : (
                <div className="divide-y divide-border">
                  {slowQueryLog.map((q) => (
                    <div
                      key={q.id}
                      className="flex items-start gap-2 px-3 py-2 hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex flex-col items-center shrink-0 mt-0.5">
                        <Clock size={12} className="text-red-400" />
                        <span className="text-[10px] font-mono text-red-400 mt-0.5">
                          {q.duration.toFixed(0)}ms
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all">
                          {q.sql.length > 200 ? q.sql.substring(0, 200) + '...' : q.sql}
                        </pre>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] text-muted-foreground">
                            {q.connectionId}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(q.timestamp).toLocaleString()}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => handleRerunSlowQuery(q)}
                          className="p-1 rounded hover:bg-muted transition-colors"
                          title={t('analyzer.rerun')}
                        >
                          <RotateCcw size={10} className="text-muted-foreground" />
                        </button>
                        <button
                          onClick={() => handleDeleteSlowQuery(q.id)}
                          className="p-1 rounded hover:bg-muted transition-colors"
                          title={t('common.delete')}
                        >
                          <Trash2 size={10} className="text-muted-foreground" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
