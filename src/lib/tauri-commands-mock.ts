import { log } from "@/lib/log";
export function isMockMode(): boolean {
  return import.meta.env.VITE_MOCK_MODE === 'true'
}

// Mock plugin data
const mockRegistryPlugins = [
  {
    id: 'tabularis-postgres-driver',
    name: 'PostgreSQL Driver',
    description: 'Official PostgreSQL database driver for Tabularis',
    author: 'Tabularis Team',
    homepage: 'https://github.com/tabularisdb/tabularis-postgres-driver',
    latest_version: '1.2.3',
    releases: [
      {
        version: '1.2.3',
        min_tabularis_version: '1.0.0',
        assets: {
          'darwin-arm64': 'https://example.com/assets/darwin-arm64.tgz',
          'linux-x64': 'https://example.com/assets/linux-x64.tgz',
          'windows-x64': 'https://example.com/assets/windows-x64.tgz',
        }
      }
    ]
  },
  {
    id: 'tabularis-ai-helper',
    name: 'AI Helper Plugin',
    description: 'Enhance your database experience with AI-powered features',
    author: 'Tabularis Team',
    homepage: 'https://github.com/tabularisdb/tabularis-ai-helper',
    latest_version: '2.0.0',
    releases: [
      {
        version: '2.0.0',
        min_tabularis_version: '1.5.0',
        assets: {
          'darwin-arm64': 'https://example.com/assets/ai-helper-darwin-arm64.tgz',
          'linux-x64': 'https://example.com/assets/ai-helper-linux-x64.tgz',
          'windows-x64': 'https://example.com/assets/ai-helper-windows-x64.tgz',
        }
      }
    ]
  },
  {
    id: 'tabularis-chart-plugin',
    name: 'Advanced Charts',
    description: 'Create beautiful and interactive charts from your database data',
    author: 'Community',
    homepage: 'https://github.com/tabularisdb/tabularis-chart-plugin',
    latest_version: '1.0.5',
    releases: [
      {
        version: '1.0.5',
        min_tabularis_version: '1.0.0',
        assets: {
          'darwin-arm64': 'https://example.com/assets/chart-darwin-arm64.tgz',
          'linux-x64': 'https://example.com/assets/chart-linux-x64.tgz',
          'windows-x64': 'https://example.com/assets/chart-windows-x64.tgz',
        }
      }
    ]
  },
]

const mockInstalledPlugins = [
  {
    id: 'tabularis-postgres-driver',
    name: 'PostgreSQL Driver',
    version: '1.2.3',
    description: 'Official PostgreSQL database driver for Tabularis',
    enabled: true,
  },
]

export async function mockInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const mockData: Record<string, any> = {
    get_connections: async () => [],
    add_connection: async (conn: any) => conn,
    update_connection: async (_id: string, updates: any) => updates,
    delete_connection: async () => {},
    connect_to_database: async () => true,
    disconnect_database: async () => {},
    execute_query: async () => ({ columns: [], rows: [], rowCount: 0, duration: 0 }),
    execute_query_paged: async () => ({ columns: [], rows: [], rowCount: 0, duration: 0, hasMore: false }),
    execute_batch: async () => [{ columns: [], rows: [], rowCount: 0, duration: 0 }],
    execute_sql: async () => ({ rowsAffected: 0 }),
    get_tables: async () => [],
    get_columns: async () => [],
    get_views: async () => [],
    get_databases: async () => ['mockdb'],
    get_schemas: async () => ['public'],
    get_indexes: async () => [],
    get_foreign_keys: async () => [],
    get_table_row_count: async () => 0,
    get_table_data: async () => ({ columns: [], rows: [], rowCount: 0, duration: 0 }),
    update_table_rows: async () => ({ rowsAffected: 0 }),
    insert_table_row: async () => ({ rowsAffected: 1 }),
    delete_table_rows: async () => ({ rowsAffected: 0 }),
    export_table_sql: async () => '-- mock DDL',
    cancel_query: async () => true,
    get_driver_capabilities: async () => ({ supportsSchemas: true, supportsViews: true }),
    test_connection_cmd: async () => ({ success: true }),
    // Plugin commands
    list_plugins: async () => mockInstalledPlugins,
    fetch_plugin_registry: async () => mockRegistryPlugins,
    install_plugin: async (args: any) => {
      log.debug('Installing plugin:', args.plugin_id, 'version:', args.version)
      return Promise.resolve()
    },
    remove_plugin: async (args: any) => {
      log.debug('Removing plugin:', args.plugin_id)
      return Promise.resolve()
    },
    enable_plugin: async (args: any) => {
      log.debug('Enabling plugin:', args.plugin_id)
      return Promise.resolve()
    },
    disable_plugin: async (args: any) => {
      log.debug('Disabling plugin:', args.plugin_id)
      return Promise.resolve()
    },
    reload_plugins: async () => mockInstalledPlugins,
    // Update commands
    'updater:check': async () => ({
      available: false,
      version: '1.0.0',
      date: '2024-01-01',
      body: 'Latest version',
      url: ''
    }),
    'updater:install': async () => Promise.resolve(),
  }

  const cmd = command as keyof typeof mockData
  if (mockData[cmd]) {
    return (mockData[cmd] as any)(args)
  }
  return Promise.resolve({} as T)
}
