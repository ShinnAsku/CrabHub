import {
  snapshotQueryResults,
  type QueryPagination,
  type QueryResultSlot,
} from '@/features/editor/batch-results'
import { executeScriptStream, mapStatementOutcome } from '@/features/editor/execution-client'
import { useTransactionStore } from '@/features/editor/transaction-store'
import {
  downloadFile,
  exportToCSV,
  exportToJSON,
  exportToSQL,
  importFromCSV,
  importFromJSON,
} from '@/lib/export'
import { t } from '@/lib/i18n'
import { conversionHeader, convertSql } from '@/lib/sql-convert'
import { SQL_KEYWORDS, splitSqlStatements } from '@/lib/sql-utils'
import {
  executeBatch,
  executeQueryPaged,
  executeSql,
  getColumns,
  getDatabases,
  getDriverCapabilities,
  getSchemas,
  getTables,
  switchDatabase,
  type BatchResultItem,
} from '@/lib/tauri-commands'
import { useConnectionStore, useTabStore, useUIStore } from '@/stores/app-store'
import { useExplorerStore } from '@/features/explorer/store'
import { useHistoryStore } from '@/stores/modules/history'
import type {
  ColumnInfo,
  Connection,
  PagedQueryResult,
  QueryHistoryEntry,
  QueryResult,
  TableRow,
} from '@/types/index'
import { type OnMount } from '@monaco-editor/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { format as formatSQL } from 'sql-formatter'
import { useShallow } from 'zustand/react/shallow'

type ResultTab = 'results' | 'messages'
const QUERY_PAGE_SIZE = 500
export function useQueryEditor() {
  const {
    tabs,
    activeTabId,
    queryResults,
    isExecuting,
    updateTabContent,
    setQueryResult,
    setIsExecuting,
  } = useTabStore(
    useShallow(state => ({
      tabs: state.tabs,
      activeTabId: state.activeTabId,
      queryResults: state.queryResults,
      isExecuting: state.isExecuting,
      updateTabContent: state.updateTabContent,
      setQueryResult: state.setQueryResult,
      setIsExecuting: state.setIsExecuting,
    }))
  )
  const { activeConnectionId, connections } = useConnectionStore(
    useShallow(state => ({
      activeConnectionId: state.activeConnectionId,
      connections: state.connections,
    }))
  )
  const { theme, toggleSnippetPanel } = useUIStore(
    useShallow(state => ({
      theme: state.theme,
      toggleSnippetPanel: state.toggleSnippetPanel,
      language: state.language,
    }))
  )

  const editorRef = useRef<any>(null)
  const monacoRef = useRef<any>(null)
  const [resultTab, setResultTab] = useState<ResultTab>('results')
  const [messages, setMessages] = useState<string[]>([])
  const [executionTime, setExecutionTime] = useState<number | null>(null)
  const [importPreview, setImportPreview] = useState<{
    columns: string[]
    rows: TableRow[]
  } | null>(null)
  const [importTableName, setImportTableName] = useState('imported_data')
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [multiResults, setMultiResults] = useState<QueryResult[]>([])
  const [activeResultIdx, setActiveResultIdx] = useState(0)
  const [executionMode, setExecutionMode] = useState<'legacy' | 'script' | 'independent'>('legacy')
  const [readConcurrency, setReadConcurrency] = useState(4)
  const [scriptSupported, setScriptSupported] = useState(false)
  const [atomicScript, setAtomicScript] = useState(false)
  const [stopOnError, setStopOnError] = useState(true)
  const executionRef = useRef<{
    id: string
    tabId: string
    controller: AbortController
    script: boolean
  } | null>(null)
  const activeRunIds = useRef(new Map<string, string>())
  const resultGeneration = useRef(0)
  const [chartPanel, setChartPanel] = useState<{
    columns: string[]
    rows: Record<string, unknown>[]
  } | null>(null)

  // Scroll-to-load-more state for query results
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadMoreState, setLoadMoreState] = useState<
    Record<number, { hasMore: boolean; currentOffset: number; originalSql: string }>
  >({})

  // Dynamic completion data: schema names, table names, column names
  const dbSchemasRef = useRef<string[]>([])
  const dbTablesRef = useRef<{ name: string; schema?: string }[]>([])
  const dbColumnsRef = useRef<Record<string, string[]>>({})
  /// Mirror of effectiveConnectionId for the completion provider (registered
  /// once with an empty closure — reading state directly would go stale).
  const effectiveConnIdRef = useRef<string | null>(null)

  // Connection selector state
  const [selectedConnId, setSelectedConnId] = useState<string | null>(activeConnectionId)

  // Confirm dialog state
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string
    onConfirm: () => void
  } | null>(null)

  const activeTab = tabs.find(t => t.id === activeTabId)
  const result = activeTabId ? queryResults[activeTabId] : undefined
  const connectedConnections = connections.filter((c: Connection) => c.connected)
  const transaction = useTransactionStore(state =>
    activeTabId ? state.sessions[activeTabId] : undefined
  )
  const transactionPending = useTransactionStore(state =>
    activeTabId ? !!state.pending[activeTabId] : false
  )
  const effectiveConnectionId = transaction?.connectionId || selectedConnId || activeConnectionId
  const activeConnection = connections.find(c => c.id === effectiveConnectionId)
  const isTxActive = !!transaction

  useEffect(() => {
    if (activeTabId && activeConnection?.connected === false) {
      void useTransactionStore
        .getState()
        .cancel(activeTabId)
        .catch(() => {})
    }
  }, [activeTabId, activeConnection?.connected, transaction?.transactionId])

  useEffect(() => {
    if (!activeTabId || !transaction) return
    const refresh = () => {
      void useTransactionStore.getState().refresh(activeTabId)
    }
    refresh()
    const interval = window.setInterval(refresh, 15000)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', refresh)
    }
  }, [activeTabId, transaction?.transactionId])

  useEffect(() => {
    let current = true
    setScriptSupported(false)
    setExecutionMode('legacy')
    if (effectiveConnectionId && activeConnection?.connected) {
      getDriverCapabilities(effectiveConnectionId)
        .then(capabilities => {
          if (current) setScriptSupported(capabilities.supportsScriptSessions === true)
        })
        .catch(() => {})
    }
    return () => {
      current = false
    }
  }, [effectiveConnectionId, activeConnection?.connected])

  useEffect(() => {
    resultGeneration.current += 1
    setIsLoadingMore(false)
    setMessages([])
    setMultiResults([])
    setLoadMoreState({})
    setExecutionTime(null)
    return () => {
      resultGeneration.current += 1
      const execution = executionRef.current
      if (execution?.script) execution.controller.abort()
    }
  }, [activeTabId, effectiveConnectionId])

  // Sync selectedConnId when global activeConnectionId changes
  useEffect(() => {
    if (activeConnectionId) {
      setSelectedConnId(activeConnectionId)
    }
  }, [activeConnectionId])

  // Handle connection change
  const handleConnectionChange = useCallback((connId: string) => {
    setSelectedConnId(connId)
    useConnectionStore.getState().setActiveConnection(connId)
  }, [])

  // Handle database change
  const [selectedDatabase, setSelectedDatabase] = useState<string>('')
  const [databaseList, setDatabaseList] = useState<string[]>([])

  const selectedSchemaName = useExplorerStore(state => state.selectedSchemaName)

  // Load databases when connection changes
  useEffect(() => {
    if (!effectiveConnectionId) {
      setDatabaseList([])
      setSelectedDatabase('')
      return
    }
    const conn = connections.find((c: Connection) => c.id === effectiveConnectionId)
    if (!conn || conn.type === 'sqlite') {
      setDatabaseList([])
      setSelectedDatabase('')
      return
    }
    getDatabases(effectiveConnectionId)
      .then(dbs => {
        const schemaName = selectedSchemaName
        setDatabaseList(dbs)
        const firstDb = dbs[0]
        if (dbs.length === 1 && firstDb) {
          setSelectedDatabase(firstDb)
          if (
            effectiveConnectionId &&
            !Object.values(useTransactionStore.getState().sessions).some(
              session => session.connectionId === effectiveConnectionId
            )
          ) {
            void switchDatabase(effectiveConnectionId, firstDb).catch(() => {})
          }
        } else if (schemaName && dbs.includes(schemaName)) {
          setSelectedDatabase(schemaName)
        }
      })
      .catch(() => setDatabaseList([]))
  }, [effectiveConnectionId])

  // Sync database from sidebar context
  useEffect(() => {
    const schemaName = selectedSchemaName
    if (
      !isTxActive &&
      schemaName &&
      databaseList.includes(schemaName) &&
      schemaName !== selectedDatabase
    ) {
      setSelectedDatabase(schemaName)
      if (effectiveConnectionId) {
        switchDatabase(effectiveConnectionId, schemaName)
      }
    }
  }, [selectedSchemaName, databaseList, effectiveConnectionId, selectedDatabase, isTxActive])

  const handleDatabaseChange = useCallback(
    (dbName: string) => {
      if (isTxActive) return
      setSelectedDatabase(dbName)
      if (effectiveConnectionId && dbName) {
        switchDatabase(effectiveConnectionId, dbName)
      }
    },
    [effectiveConnectionId, isTxActive]
  )

  // Load schemas and table NAMES for autocomplete when connection changes.
  // Table names are cheap (one metadata query); column lists are fetched
  // lazily by the completion provider the first time `table.` is typed —
  // the previous eager per-table loop capped at 50 tables and fired up to
  // 50 queries on every connection switch.
  useEffect(() => {
    effectiveConnIdRef.current = effectiveConnectionId ?? null
    if (!effectiveConnectionId) {
      dbSchemasRef.current = []
      dbTablesRef.current = []
      dbColumnsRef.current = {}
      return
    }
    dbColumnsRef.current = {}
    // Load schemas
    getSchemas(effectiveConnectionId)
      .then(schemas => {
        dbSchemasRef.current = schemas
      })
      .catch(() => {
        dbSchemasRef.current = []
      })
    // Load table names (ALL tables — no 50-table cap)
    getTables(effectiveConnectionId)
      .then(tables => {
        dbTablesRef.current = tables.map(t => ({ name: t.name, schema: t.schema }))
      })
      .catch(() => {
        dbTablesRef.current = []
      })
  }, [effectiveConnectionId])

  // Clear stale editor refs when tab changes to prevent accessing disposed Monaco instances
  useEffect(() => {
    editorRef.current = null
    monacoRef.current = null
  }, [activeTabId])

  // Register SQL completion provider once
  const completionDisposableRef = useRef<any>(null)

  const handleEditorMount: OnMount = useCallback((editor, monacoInstance) => {
    editorRef.current = editor
    monacoRef.current = monacoInstance

    // Custom right-click context menu
    editor.onContextMenu((e: any) => {
      e.event.preventDefault()
      e.event.stopPropagation()
      setContextMenu({ x: e.event.posx, y: e.event.posy })
    })

    // Register SQL completion provider with dynamic db objects (only once)
    if (!completionDisposableRef.current) {
      completionDisposableRef.current = monacoInstance.languages.registerCompletionItemProvider(
        'sql',
        {
          triggerCharacters: ['.', ' '],
          provideCompletionItems: async (model: any, position: any) => {
            const word = model.getWordUntilPosition(position)
            const range = {
              startLineNumber: position.lineNumber,
              endLineNumber: position.lineNumber,
              startColumn: word.startColumn,
              endColumn: word.endColumn,
            }

            // Check if typing after a dot (e.g. "schema." or "table.")
            const textBeforeCursor = model.getValueInRange({
              startLineNumber: position.lineNumber,
              startColumn: 1,
              endLineNumber: position.lineNumber,
              endColumn: word.startColumn,
            })
            const dotMatch = textBeforeCursor.match(/(\w+)\.$/)

            const suggestions: any[] = []

            if (dotMatch) {
              const prefix = dotMatch[1]
              // If prefix is a schema name, suggest tables in that schema
              if (dbSchemasRef.current.includes(prefix)) {
                dbTablesRef.current
                  .filter(t => t.schema === prefix)
                  .forEach(t => {
                    suggestions.push({
                      label: t.name,
                      kind: monacoInstance.languages.CompletionItemKind.Field,
                      insertText: t.name,
                      detail: 'Table',
                      range,
                    })
                  })
              }
              // If prefix is a table name, suggest columns — fetched on demand
              // the first time and cached for the connection's lifetime.
              let cols = dbColumnsRef.current[prefix]
              if (!cols) {
                const tableMeta = dbTablesRef.current.find(t => t.name === prefix)
                const connId = effectiveConnIdRef.current
                if (tableMeta && connId) {
                  try {
                    const fetched = await getColumns(connId, tableMeta.name, tableMeta.schema)
                    cols = fetched.map(c => c.name)
                    dbColumnsRef.current[prefix] = cols
                  } catch {
                    /* table may be a alias or unreadable — no columns */
                  }
                }
              }
              if (cols) {
                cols.forEach(col => {
                  suggestions.push({
                    label: col,
                    kind: monacoInstance.languages.CompletionItemKind.Property,
                    insertText: col,
                    detail: 'Column',
                    range,
                  })
                })
              }
            } else {
              // SQL keywords
              SQL_KEYWORDS.forEach(kw => {
                suggestions.push({
                  label: kw,
                  kind: monacoInstance.languages.CompletionItemKind.Keyword,
                  insertText: kw,
                  range,
                  sortText: `2_${kw}`,
                })
              })
              // Schema names
              dbSchemasRef.current.forEach(schema => {
                suggestions.push({
                  label: schema,
                  kind: monacoInstance.languages.CompletionItemKind.Module,
                  insertText: schema,
                  detail: 'Schema',
                  range,
                  sortText: `0_${schema}`,
                })
              })
              // Table names
              dbTablesRef.current.forEach(t => {
                suggestions.push({
                  label: t.name,
                  kind: monacoInstance.languages.CompletionItemKind.Field,
                  insertText: t.name,
                  detail: t.schema ? `Table (${t.schema})` : 'Table',
                  range,
                  sortText: `1_${t.name}`,
                })
              })
              // Column names (all tables)
              const addedCols = new Set<string>()
              Object.entries(dbColumnsRef.current).forEach(([tableName, cols]) => {
                cols.forEach(col => {
                  if (!addedCols.has(col)) {
                    addedCols.add(col)
                    suggestions.push({
                      label: col,
                      kind: monacoInstance.languages.CompletionItemKind.Property,
                      insertText: col,
                      detail: `Column (${tableName})`,
                      range,
                      sortText: `3_${col}`,
                    })
                  }
                })
              })
            }

            return { suggestions }
          },
        }
      )
    }
  }, [])

  // Listen for custom events from Toolbar
  useEffect(() => {
    const handleExportEvent = (e: Event) => {
      const { format } = (e as CustomEvent).detail
      handleExport(format)
    }
    const handleImportEvent = (e: Event) => {
      const { type } = (e as CustomEvent).detail
      handleImport(type)
    }
    const handleExecuteEvent = () => {
      handleExecute()
    }

    window.addEventListener('crabhub:export', handleExportEvent)
    window.addEventListener('crabhub:import', handleImportEvent)
    window.addEventListener('crabhub:execute-query', handleExecuteEvent)

    return () => {
      window.removeEventListener('crabhub:export', handleExportEvent)
      window.removeEventListener('crabhub:import', handleImportEvent)
      window.removeEventListener('crabhub:execute-query', handleExecuteEvent)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, effectiveConnectionId, result])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (activeTabId && value !== undefined) {
        if (debounceRef.current) clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => {
          updateTabContent(activeTabId, value)
        }, 300)
      }
    },
    [activeTabId, updateTabContent]
  )

  const handleExecute = useCallback(
    async (selectedOnly?: boolean) => {
      if (!activeTabId || !effectiveConnectionId || !editorRef.current) return
      if (useTransactionStore.getState().pending[activeTabId]) return
      if (activeRunIds.current.has(activeTabId)) return

      let sqlText: string
      try {
        if (selectedOnly) {
          const selection = editorRef.current.getSelection()
          if (selection && !selection.isEmpty()) {
            sqlText = editorRef.current.getModel()?.getValueInRange(selection)?.trim() || ''
          } else {
            return
          }
        } else {
          const selection = editorRef.current.getSelection()
          if (selection && !selection.isEmpty()) {
            sqlText = editorRef.current.getModel()?.getValueInRange(selection)?.trim() || ''
          } else {
            sqlText = editorRef.current.getValue().trim()
          }
        }
      } catch {
        return
      }
      if (!sqlText) return

      // Split into individual statements
      const statements = splitSqlStatements(sqlText)
      if (statements.length === 0) return

      const executionId = crypto.randomUUID()
      const controller = new AbortController()
      const activeTransaction = useTransactionStore.getState().sessions[activeTabId]
      const useScript = !activeTransaction && executionMode !== 'legacy' && scriptSupported
      const useAtomic = executionMode === 'script' && atomicScript
      activeRunIds.current.set(activeTabId, executionId)
      executionRef.current = { id: executionId, tabId: activeTabId, controller, script: useScript }
      const isCurrent = () =>
        activeRunIds.current.get(activeTabId) === executionId &&
        useTabStore.getState().activeTabId === activeTabId &&
        executionRef.current?.id === executionId

      setIsExecuting(activeTabId!, true)
      setMessages([])
      setExecutionTime(null)
      setImportPreview(null)
      setMultiResults([])
      resultGeneration.current += 1
      setIsLoadingMore(false)
      setLoadMoreState({})

      const startTime = performance.now()
      const allMessages: string[] = []
      const historyEntries: Omit<QueryHistoryEntry, 'id'>[] = []
      let collectedResults: QueryResult[] = []
      const resultSlots = new Map<number, QueryResultSlot>()
      let newLoadMoreState: Record<number, QueryPagination> = {}
      const refreshResults = () => {
        const snapshot = snapshotQueryResults(resultSlots)
        collectedResults = snapshot.results
        newLoadMoreState = snapshot.pagination
      }

      const applied = new Set<number>()
      const applyResult = (raw: BatchResultItem, index: number) => {
        if (applied.has(index)) return
        applied.add(index)
        const sql = statements[index]!
        if (raw?.type === 'empty') return
        if (raw?.type === 'error') {
          allMessages.push(`[${index + 1}/${statements.length}] ${raw.message}`)
          return
        }
        const stmtElapsed = raw.duration ?? 0
        // Map result: PagedQueryResult has columns + rows
        if (raw.columns) {
          const qr = raw as QueryResult
          resultSlots.set(index, { result: qr, hasMore: raw.hasMore ?? false, sql })
          const prefix = statements.length > 1 ? `[${index + 1}/${statements.length}] ` : ''
          allMessages.push(
            `${prefix}${t('editor.querySuccess', { rows: String(qr.rowCount ?? 0), ms: stmtElapsed.toFixed(0) })}`
          )
          historyEntries.push({
            connectionId: effectiveConnectionId,
            sql,
            duration: stmtElapsed,
            timestamp: new Date(),
            rowCount: qr.rowCount || 0,
          })
        } else {
          const prefix = statements.length > 1 ? `[${index + 1}/${statements.length}] ` : ''
          allMessages.push(
            `${prefix}${t('editor.executeSuccess', { message: raw?.message ?? '', ms: stmtElapsed.toFixed(0) })}`
          )
          historyEntries.push({
            connectionId: effectiveConnectionId,
            sql,
            duration: stmtElapsed,
            timestamp: new Date(),
            rowCount: 0,
          })
        }
      }
      let lastPublished = 0
      const publish = (force = false) => {
        if (!isCurrent() || (!force && performance.now() - lastPublished < 50)) return
        lastPublished = performance.now()
        refreshResults()
        setMessages([...allMessages])
        setMultiResults([...collectedResults])
        setLoadMoreState({ ...newLoadMoreState })
        if (collectedResults[0]) {
          setQueryResult(activeTabId, collectedResults[0])
          setResultTab('results')
        } else {
          setResultTab('messages')
        }
      }

      try {
        if (activeTransaction) {
          const outcome = await useTransactionStore.getState().execute(activeTabId, statements)
          outcome.statements.forEach(statement => {
            applyResult(mapStatementOutcome(statement), statement.statementIndex)
            if (statement.truncated)
              allMessages.push(
                t('editor.scriptTruncated', { index: String(statement.statementIndex + 1) })
              )
          })
        } else if (useScript) {
          if (useAtomic) allMessages.push(t('editor.scriptPendingTransaction'))
          const outcome = await executeScriptStream(
            {
              id: effectiveConnectionId,
              executionId,
              statements,
              options: { atomic: useAtomic, stopOnError: useAtomic || stopOnError },
              mode: executionMode === 'independent' ? 'independent' : 'script',
              concurrency: readConcurrency,
            },
            update => {
              if (update.kind === 'statement') {
                applyResult(mapStatementOutcome(update.statement), update.statement.statementIndex)
                if (update.statement.truncated)
                  allMessages.push(
                    t('editor.scriptTruncated', {
                      index: String(update.statement.statementIndex + 1),
                    })
                  )
                publish()
              }
            },
            controller.signal
          )
          outcome.statements.forEach(statement =>
            applyResult(mapStatementOutcome(statement), statement.statementIndex)
          )
          if (outcome.transaction !== 'native')
            allMessages.push(t(`editor.transactionOutcome.${outcome.transaction}`))
          if (outcome.cleanupError) allMessages.push(outcome.cleanupError)
        } else {
          const rawResults = await executeBatch(effectiveConnectionId, statements)
          rawResults.forEach(applyResult)
        }
        if (!isCurrent()) return

        refreshResults()
        const totalElapsed = performance.now() - startTime
        setExecutionTime(totalElapsed)
        setMessages(allMessages)
        setMultiResults(collectedResults)
        setActiveResultIdx(0)
        setLoadMoreState(newLoadMoreState)

        // Sync frontend connection state after auto-reconnect
        const currentConn = useConnectionStore
          .getState()
          .connections.find(c => c.id === effectiveConnectionId)
        if (currentConn && !currentConn.connected) {
          useConnectionStore
            .getState()
            .updateConnectionStatus(effectiveConnectionId, {
              connected: true,
              lastConnected: new Date(),
            })
        }

        if (collectedResults.length > 0) {
          setQueryResult(activeTabId, collectedResults[0]!)
          setResultTab('results')
        } else {
          setQueryResult(activeTabId, {
            columns: [],
            rows: [],
            rowCount: 0,
            duration: totalElapsed,
          })
          setResultTab('messages')
        }
      } catch (err) {
        if (!isCurrent()) return
        refreshResults()
        const totalElapsed = performance.now() - startTime
        setExecutionTime(totalElapsed)
        const errorMsg =
          err instanceof Error
            ? err.message
            : typeof err === 'string'
              ? err
              : t('editor.executeFailed')
        allMessages.push(t('editor.errorPrefix', { error: errorMsg }))
        setMessages(allMessages)
        setMultiResults(collectedResults)
        setActiveResultIdx(0)
        setLoadMoreState(newLoadMoreState)

        if (collectedResults.length > 0) {
          setQueryResult(activeTabId, collectedResults[0]!)
        } else {
          setQueryResult(activeTabId, {
            columns: [],
            rows: [],
            rowCount: 0,
            duration: totalElapsed,
          })
        }
        setResultTab('messages')
      } finally {
        useHistoryStore.getState().addQueryHistoryBatch(historyEntries)
        if (activeRunIds.current.get(activeTabId) === executionId) {
          activeRunIds.current.delete(activeTabId)
          setIsExecuting(activeTabId, false)
        }
        if (executionRef.current?.id === executionId) executionRef.current = null
      }
    },
    [
      activeTabId,
      effectiveConnectionId,
      activeConnection,
      setQueryResult,
      setIsExecuting,
      executionMode,
      scriptSupported,
      atomicScript,
      stopOnError,
      readConcurrency,
    ]
  )

  // Load more rows for a specific result index
  const MAX_DISPLAY_ROWS = 10000

  const handleLoadMore = useCallback(
    async (resultIdx: number) => {
      if (isLoadingMore || !effectiveConnectionId) return
      const state = loadMoreState[resultIdx]
      if (!state || !state.hasMore) return

      const generation = resultGeneration.current
      setIsLoadingMore(true)
      try {
        const pagedResult: PagedQueryResult = await executeQueryPaged(
          effectiveConnectionId,
          state.originalSql,
          QUERY_PAGE_SIZE,
          state.currentOffset
        )
        if (resultGeneration.current !== generation) return

        setMultiResults(prev => {
          const updated = [...prev]
          if (updated[resultIdx]) {
            const existing = updated[resultIdx]
            const newTotal = existing.rows.length + pagedResult.rows.length
            if (newTotal > MAX_DISPLAY_ROWS) {
              updated[resultIdx] = {
                ...existing,
                rowCount: Math.min(newTotal, MAX_DISPLAY_ROWS),
              }
            } else {
              updated[resultIdx] = {
                ...existing,
                rows: [...existing.rows, ...pagedResult.rows],
                rowCount: newTotal,
              }
            }
            if (activeTabId && activeResultIdx === resultIdx) {
              setQueryResult(activeTabId, updated[resultIdx])
            }
          }
          return updated
        })

        setLoadMoreState(prev => ({
          ...prev,
          [resultIdx]: {
            ...state,
            hasMore:
              state.currentOffset + pagedResult.rows.length < MAX_DISPLAY_ROWS &&
              pagedResult.hasMore,
            currentOffset: state.currentOffset + pagedResult.rows.length,
          },
        }))
      } catch (err) {
        if (resultGeneration.current !== generation) return
        const errorMsg = err instanceof Error ? err.message : String(err)
        setMessages(prev => [...prev, t('editor.errorPrefix', { error: errorMsg })])
      } finally {
        if (resultGeneration.current === generation) setIsLoadingMore(false)
      }
    },
    [
      isLoadingMore,
      effectiveConnectionId,
      loadMoreState,
      activeTabId,
      activeResultIdx,
      setQueryResult,
    ]
  )

  // Bind Ctrl+Enter whenever activeTabId or effectiveConnectionId changes
  useEffect(() => {
    const editor = editorRef.current
    const monaco = monacoRef.current
    if (!editor || !monaco) return
    try {
      const disposable = editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
        handleExecute()
      )
      return () => {
        try {
          disposable?.dispose()
        } catch {}
      }
    } catch {
      return undefined
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, effectiveConnectionId, handleExecute])

  // Context menu helpers
  const hasSelection = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return false
    const selection = editor.getSelection()
    return selection ? !selection.isEmpty() : false
  }, [])

  const getSelectedText = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return ''
    const selection = editor.getSelection()
    if (!selection || selection.isEmpty()) return ''
    return editor.getModel()?.getValueInRange(selection) || ''
  }, [])

  const handleCut = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return
    const text = getSelectedText()
    if (!text) return
    try {
      const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
      if (isTauri) {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
        await writeText(text)
      } else {
        await navigator.clipboard.writeText(text)
      }
      // Delete selected text
      const selection = editor.getSelection()
      if (selection) {
        editor.executeEdits('cut', [
          {
            range: selection,
            text: '',
          },
        ])
      }
    } catch {
      // fallback: use document.execCommand
      editor.focus()
      document.execCommand('cut')
    }
    editor.focus()
  }, [getSelectedText])

  const handleCopy = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return
    const text = getSelectedText()
    if (!text) return
    try {
      const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
      if (isTauri) {
        const { writeText } = await import('@tauri-apps/plugin-clipboard-manager')
        await writeText(text)
      } else {
        await navigator.clipboard.writeText(text)
      }
    } catch {
      editor.focus()
      document.execCommand('copy')
    }
    editor.focus()
  }, [getSelectedText])

  const handlePaste = useCallback(async () => {
    const editor = editorRef.current
    if (!editor) return
    try {
      let text: string | null = null
      const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
      if (isTauri) {
        const { readText } = await import('@tauri-apps/plugin-clipboard-manager')
        text = await readText()
      } else {
        text = await navigator.clipboard.readText()
      }
      if (text) {
        const selection = editor.getSelection()
        if (selection) {
          editor.executeEdits('paste', [
            {
              range: selection,
              text: text,
            },
          ])
        }
      }
    } catch {
      editor.focus()
      document.execCommand('paste')
    }
    editor.focus()
  }, [])

  const handleSelectAll = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const model = editor.getModel()
    if (model) {
      const fullRange = model.getFullModelRange()
      editor.setSelection(fullRange)
    }
  }, [])

  const handleSelectCurrentStatement = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.focus()
    const model = editor.getModel()
    if (!model) return
    const position = editor.getPosition()
    if (!position) return

    const fullText = model.getValue()
    const offset = model.getOffsetAt(position)
    // Find the statement boundaries (split by semicolons)
    let start = 0
    let end = fullText.length
    const parts = fullText.split(';')
    let currentOffset = 0
    for (const part of parts) {
      const partEnd = currentOffset + part.length
      if (offset >= currentOffset && offset <= partEnd) {
        start = currentOffset
        end = partEnd
        break
      }
      currentOffset = partEnd + 1 // +1 for the semicolon
    }
    const startPos = model.getPositionAt(start)
    const endPos = model.getPositionAt(end)
    editor.setSelection({
      startLineNumber: startPos.lineNumber,
      startColumn: startPos.column,
      endLineNumber: endPos.lineNumber,
      endColumn: endPos.column,
    })
  }, [])

  const handleFormat = useCallback(() => {
    if (!editorRef.current || !activeTabId) return
    try {
      const currentValue = editorRef.current.getValue()
      if (!currentValue?.trim()) return
      const formatted = formatSQL(currentValue, {
        language: 'sql',
        tabWidth: 2,
        keywordCase: 'upper',
        linesBetweenQueries: 2,
      })
      editorRef.current.setValue(formatted)
      updateTabContent(activeTabId, formatted)
    } catch {}
  }, [activeTabId, updateTabContent])

  /** Convert the selection (or whole script) to another SQL dialect and open
   *  the result in a new query tab, with warnings as a comment header. */
  const handleConvertDialect = useCallback(
    (target: string) => {
      const editor = editorRef.current
      if (!editor || !activeConnection) return
      const selection = editor.getSelection()
      const selectedText =
        selection && !selection.isEmpty()
          ? (editor.getModel()?.getValueInRange(selection) ?? '')
          : ''
      const source = selectedText || editor.getValue()
      if (!source.trim()) return

      const { sql: converted, warnings } = convertSql(source, activeConnection.type, target)
      const content = conversionHeader(activeConnection.type, target, warnings) + converted
      useTabStore.getState().addTab({
        title: `${t('convert.tabTitle')} → ${target}`,
        type: 'query',
        content,
      })
    },
    [activeConnection]
  )

  const handleGenerateChart = useCallback(() => {
    const selectedResult = multiResults[activeResultIdx]
    if (!selectedResult || selectedResult.columns.length === 0) return
    setChartPanel({
      columns: selectedResult.columns.map((c: ColumnInfo) => c.name),
      rows: selectedResult.rows,
    })
  }, [multiResults, activeResultIdx])

  const handleExport = useCallback(
    (format: 'csv' | 'json' | 'sql') => {
      if (!result || result.columns.length === 0) return
      let content = ''
      let filename = ''
      let mimeType = ''

      switch (format) {
        case 'csv':
          content = exportToCSV(result.columns, result.rows)
          filename = 'query_result.csv'
          mimeType = 'text/csv'
          break
        case 'json':
          content = exportToJSON(result.columns, result.rows)
          filename = 'query_result.json'
          mimeType = 'application/json'
          break
        case 'sql':
          content = exportToSQL(result.columns, result.rows, 'query_result')
          filename = 'query_result.sql'
          mimeType = 'text/plain'
          break
      }

      downloadFile(content, filename, mimeType)
    },
    [result]
  )

  const handleImport = useCallback(async (type: 'csv' | 'json') => {
    if (activeTabId && useTransactionStore.getState().sessions[activeTabId]) {
      setMessages([t('common.transactionActive')])
      setResultTab('messages')
      return
    }
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

    let file: File | null = null

    if (isTauri) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({
          multiple: false,
          filters:
            type === 'csv'
              ? [{ name: 'CSV', extensions: ['csv', 'tsv'] }]
              : [{ name: 'JSON', extensions: ['json'] }],
        })
        if (!selected) return
        const { readTextFile } = await import('@tauri-apps/plugin-fs')
        const text = await readTextFile(selected as string)
        file = new File([text], (selected as string).split(/[/\\]/).pop() || `data.${type}`, {
          type,
        })
      } catch {
        return
      }
    } else {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = type === 'csv' ? '.csv,.tsv' : '.json'
      input.onchange = e => {
        const target = e.target as HTMLInputElement
        if (target.files && target.files[0]) {
          processImport(target.files[0], type)
        }
      }
      input.click()
      return
    }

    if (file) {
      processImport(file, type)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const processImport = useCallback(async (file: File, type: 'csv' | 'json') => {
    try {
      const data = type === 'csv' ? await importFromCSV(file) : await importFromJSON(file)
      setImportPreview(data)
      setResultTab('results')
      setMessages([
        t('editor.importPreview', {
          rows: String(data.rows.length),
          cols: String(data.columns.length),
        }),
      ])
    } catch (err) {
      setMessages([
        t('editor.importFailed', {
          error:
            err instanceof Error
              ? err.message
              : typeof err === 'string'
                ? err
                : t('common.unknownError'),
        }),
      ])
      setResultTab('messages')
    }
  }, [])

  const handleConfirmImport = useCallback(async () => {
    if (!importPreview || !effectiveConnectionId || !activeTabId) return

    const { columns, rows } = importPreview
    const colDefs = columns.map(c => `"${c}"`).join(', ')
    const sql = `CREATE TABLE IF NOT EXISTS "${importTableName}" (${colDefs});\n`

    const insertStatements = rows.map(row => {
      const vals = columns.map(col => {
        const val = row[col]
        if (val === null || val === undefined) return 'NULL'
        if (typeof val === 'number') return String(val)
        if (typeof val === 'boolean') return val ? '1' : '0'
        return `'${String(val).replace(/'/g, "''")}'`
      })
      return `INSERT INTO "${importTableName}" (${colDefs}) VALUES (${vals.join(', ')});`
    })

    const fullSql = sql + insertStatements.join('\n')

    setIsExecuting(activeTabId!, true)
    try {
      await executeSql(effectiveConnectionId, fullSql)
      setMessages([
        t('editor.importSuccess', { rows: String(rows.length), table: importTableName }),
      ])
      setImportPreview(null)
      setResultTab('messages')
    } catch (err) {
      setMessages([
        t('editor.importFailed', {
          error:
            err instanceof Error
              ? err.message
              : typeof err === 'string'
                ? err
                : t('common.unknownError'),
        }),
      ])
      setResultTab('messages')
    } finally {
      setIsExecuting(activeTabId!, false)
    }
  }, [importPreview, effectiveConnectionId, activeTabId, importTableName, setIsExecuting])

  const handleTransaction = useCallback(
    async (action: 'begin' | 'commit' | 'rollback') => {
      if (!effectiveConnectionId || !activeTabId) {
        setMessages(['No active connection'])
        setResultTab('messages')
        return
      }

      const labelMap: Record<string, string> = {
        begin: t('editor.beginTransactionLabel'),
        commit: t('editor.commitTransactionLabel'),
        rollback: t('editor.rollbackTransactionLabel'),
      }

      try {
        if (action === 'begin')
          await useTransactionStore.getState().begin(activeTabId, effectiveConnectionId)
        else await useTransactionStore.getState().finish(activeTabId, action)
        setMessages([t('editor.transactionSuccess', { action: labelMap[action] || action })])
        setResultTab('messages')
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        setMessages([`${t('editor.transactionFailed')}: ${errMsg}`])
        setResultTab('messages')
      }
    },
    [activeTabId, effectiveConnectionId]
  )

  return {
    activeTabId,
    isExecuting,
    setQueryResult,
    theme,
    toggleSnippetPanel,
    editorRef,
    resultTab,
    setResultTab,
    messages,
    setMessages,
    executionTime,
    importPreview,
    setImportPreview,
    importTableName,
    setImportTableName,
    contextMenu,
    setContextMenu,
    multiResults,
    activeResultIdx,
    setActiveResultIdx,
    executionMode,
    setExecutionMode,
    readConcurrency,
    setReadConcurrency,
    scriptSupported,
    atomicScript,
    setAtomicScript,
    stopOnError,
    setStopOnError,
    executionRef,
    chartPanel,
    setChartPanel,
    isLoadingMore,
    loadMoreState,
    confirmDialog,
    setConfirmDialog,
    activeTab,
    result,
    connectedConnections,
    transactionPending,
    effectiveConnectionId,
    activeConnection,
    isTxActive,
    handleConnectionChange,
    selectedDatabase,
    databaseList,
    handleDatabaseChange,
    handleEditorMount,
    handleEditorChange,
    handleExecute,
    handleLoadMore,
    hasSelection,
    handleCut,
    handleCopy,
    handlePaste,
    handleSelectAll,
    handleSelectCurrentStatement,
    handleFormat,
    handleConvertDialect,
    handleGenerateChart,
    handleExport,
    handleConfirmImport,
    handleTransaction,
  }
}
