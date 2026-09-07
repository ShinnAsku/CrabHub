import { create } from 'zustand'
import type { SchemaNode, QueryResult, TableInfo, SelectedContext } from '@/types'
import { log } from '@/lib/log'
interface ExplorerState {
  disconnect: (connectionId: string) => void
  selectedSchemaId: string | null
  selectedSchemaName: string | undefined
  selectedTableId: string | null
  selectedTable: TableInfo | null
  selectedTableData: QueryResult | null
  selectedTableDDL: string
  schemaData: Record<string, SchemaNode[]>
  selectedContext: SelectedContext | null
  setSelectedSchemaId: (id: string | null) => void
  setSelectedSchemaName: (name: string | undefined) => void
  setSelectedTableId: (id: string | null) => void
  setSelectedTable: (table: TableInfo | null) => void
  setSelectedTableData: (data: QueryResult | null) => void
  setSelectedTableDDL: (ddl: string) => void
  setSchemaData: (connectionId: string, data: SchemaNode[]) => void
  setSelectedContext: (ctx: SelectedContext | null) => void
  updateSchemaChildren: (connectionId: string, parentNodeId: string, children: SchemaNode[]) => void
}
export const useExplorerStore = create<ExplorerState>(set => ({
  disconnect: connectionId =>
    set(state => {
      const belongsToConnection = (id: string) =>
        id === connectionId || id.startsWith(`${connectionId}:sub:`)
      const schemaData = Object.fromEntries(
        Object.entries(state.schemaData).filter(([id]) => !belongsToConnection(id))
      )
      if (!state.selectedContext || !belongsToConnection(state.selectedContext.connectionId))
        return { schemaData }
      return {
        schemaData,
        selectedContext: null,
        selectedSchemaId: null,
        selectedSchemaName: undefined,
        selectedTableId: null,
        selectedTable: null,
        selectedTableData: null,
        selectedTableDDL: '',
      }
    }),
  selectedSchemaId: null,
  selectedSchemaName: undefined,
  selectedTableId: null,
  selectedTable: null,
  selectedTableData: null,
  selectedTableDDL: '',
  schemaData: {},
  selectedContext: null,
  setSelectedSchemaId: id => set({ selectedSchemaId: id }),
  setSelectedSchemaName: name => set({ selectedSchemaName: name }),
  setSelectedTableId: id => set({ selectedTableId: id }),
  setSelectedTable: table => set({ selectedTable: table }),
  setSelectedTableData: data => set({ selectedTableData: data }),
  setSelectedTableDDL: ddl => set({ selectedTableDDL: ddl }),
  setSchemaData: (connectionId, data) =>
    set(state => ({
      schemaData: { ...state.schemaData, [connectionId]: data },
    })),
  setSelectedContext: ctx => {
    log.debug('[UIStore] setSelectedContext:', JSON.stringify(ctx))
    set({ selectedContext: ctx })
  },
  updateSchemaChildren: (connectionId, parentNodeId, children) =>
    set(state => {
      const existingData = state.schemaData[connectionId] || []
      const updateNode = (nodes: SchemaNode[]): SchemaNode[] =>
        nodes.map(node => {
          if (node.id === parentNodeId) {
            return { ...node, children, loaded: true }
          }
          if (node.children) {
            return { ...node, children: updateNode(node.children) }
          }
          return node
        })
      log.debug(
        `[UIStore] updateSchemaChildren: connectionId=${connectionId}, parentNodeId=${parentNodeId}, children=${children.length}`
      )
      return { schemaData: { ...state.schemaData, [connectionId]: updateNode(existingData) } }
    }),
}))
