import type { Connection, ConnectionConfig } from '@/types/index'

export function parsePoolInput(text: string, allowZero = false): number | undefined {
  if (!text.trim()) return undefined
  const value = Number(text)
  return Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= 0xffff_ffff
    ? value
    : undefined
}

export function toRuntimeConnection(config: ConnectionConfig) {
  if (config.enableSsl && Object.values(config.sslCerts ?? {}).some(value => value?.trim())) {
    throw new Error(
      'Custom TLS certificates are not supported by this connection runtime; certificate settings were not ignored'
    )
  }
  const pool = config.poolOptions
  return {
    id: config.id || crypto.randomUUID(),
    name: config.name,
    dbType: config.type,
    host: config.host || undefined,
    port: config.port || undefined,
    username: config.username || undefined,
    password: config.password,
    database: config.type === 'sqlite' ? (config.filePath ?? config.database) : config.database,
    sslEnabled: config.enableSsl ?? false,
    sshTunnel: config.sshTunnel
      ? { ...config.sshTunnel, password: config.sshTunnel.password ?? '' }
      : undefined,
    keepaliveInterval: config.keepaliveInterval ?? 30,
    autoReconnect: config.autoReconnect ?? true,
    queryTimeoutSecs: config.queryTimeoutSecs ?? 300,
    poolOptions: pool
      ? {
          maxConnections:
            pool.maxConnections && pool.maxConnections > 0 ? pool.maxConnections : undefined,
          idleTimeoutSecs:
            pool.idleTimeoutSecs !== undefined && pool.idleTimeoutSecs >= 0
              ? pool.idleTimeoutSecs
              : undefined,
          maxLifetimeSecs:
            pool.maxLifetimeSecs !== undefined && pool.maxLifetimeSecs >= 0
              ? pool.maxLifetimeSecs
              : undefined,
          acquireTimeoutSecs:
            pool.acquireTimeoutSecs && pool.acquireTimeoutSecs > 0
              ? pool.acquireTimeoutSecs
              : undefined,
        }
      : undefined,
  }
}

export interface StoredConnection {
  id: string
  name: string
  db_type: string
  host?: string | null
  port?: number | null
  username?: string | null
  password_encrypted?: string | null
  database?: string | null
  enable_ssl?: boolean
  ssl_ca_cert?: string | null
  ssl_client_cert?: string | null
  ssl_client_key?: string | null
  ssh_tunnel_enabled?: boolean
  ssh_host?: string | null
  ssh_port?: number | null
  ssh_username?: string | null
  ssh_password_encrypted?: string | null
  ssh_private_key?: string | null
  keepalive_interval?: number
  auto_reconnect?: boolean
  query_timeout_secs?: number
  pool_options?: ConnectionConfig['poolOptions'] | null
  last_connected_at?: string | null
}

export function toStoredConnection(config: ConnectionConfig): StoredConnection {
  return {
    id: config.id,
    name: config.name,
    db_type: config.type,
    host: config.host,
    port: config.port,
    username: config.username,
    password_encrypted: config.password,
    database: config.type === 'sqlite' ? (config.filePath ?? config.database) : config.database,
    enable_ssl: config.enableSsl ?? false,
    ssl_ca_cert: config.sslCerts?.caCert,
    ssl_client_cert: config.sslCerts?.clientCert,
    ssl_client_key: config.sslCerts?.clientKey,
    ssh_tunnel_enabled: !!config.sshTunnel,
    ssh_host: config.sshTunnel?.host,
    ssh_port: config.sshTunnel?.port,
    ssh_username: config.sshTunnel?.username,
    ssh_password_encrypted: config.sshTunnel?.password,
    ssh_private_key: config.sshTunnel?.privateKey,
    keepalive_interval: config.keepaliveInterval ?? 30,
    auto_reconnect: config.autoReconnect ?? true,
    query_timeout_secs: config.queryTimeoutSecs ?? 300,
    pool_options: config.poolOptions,
  }
}

export function fromStoredConnection(stored: StoredConnection): Connection {
  return {
    id: stored.id,
    name: stored.name,
    type: stored.db_type,
    host: stored.host ?? undefined,
    port: stored.port ?? undefined,
    username: stored.username ?? undefined,
    password: stored.password_encrypted ?? undefined,
    database: stored.database ?? undefined,
    filePath: stored.db_type === 'sqlite' ? (stored.database ?? undefined) : undefined,
    enableSsl: stored.enable_ssl ?? false,
    sslCerts: {
      caCert: stored.ssl_ca_cert ?? undefined,
      clientCert: stored.ssl_client_cert ?? undefined,
      clientKey: stored.ssl_client_key ?? undefined,
    },
    sshTunnel: stored.ssh_tunnel_enabled
      ? {
          host: stored.ssh_host ?? '',
          port: stored.ssh_port ?? 22,
          username: stored.ssh_username ?? '',
          password: stored.ssh_password_encrypted ?? undefined,
          privateKey: stored.ssh_private_key ?? undefined,
        }
      : undefined,
    keepaliveInterval: stored.keepalive_interval ?? 30,
    autoReconnect: stored.auto_reconnect ?? true,
    queryTimeoutSecs: stored.query_timeout_secs ?? 300,
    poolOptions: stored.pool_options ?? undefined,
    connected: false,
    lastConnected: stored.last_connected_at ? new Date(stored.last_connected_at) : undefined,
  }
}
