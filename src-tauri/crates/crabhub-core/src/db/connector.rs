
use super::clickhouse::ClickHouseConnection;
use super::dialect::DialectConfig;
use super::gauss_rs::GaussAsyncConnection;
use super::mysql::MySqlConnection;
use super::jdbc::JdbcConnection;
use super::pg_compatible::PgCompatibleConnection;
use super::postgres::PostgresConnection;
use super::sqlserver::SqlServerConnection;
use super::sqlite::SQLiteConnection;
use super::trait_def::DatabaseConnection;
use super::types::{
    ConnectionConfig, DatabaseType, DbError,
};
use crate::plugins::driver::PluginDriver;
use crate::plugins::manager::PluginManager;



pub(super) async fn create_connection_async(
    config: &ConnectionConfig,
    plugin_manager: Option<&PluginManager>,
) -> Result<Box<dyn DatabaseConnection>, DbError> {
    match &config.db_type {
        DatabaseType::Plugin(plugin_id) => {
            let pm = plugin_manager
                .ok_or_else(|| DbError::ConfigError("Plugin manager not initialized".into()))?;
            let client = pm.get_plugin_client(plugin_id).await
                .map_err(|e| DbError::ConfigError(format!("Failed to start plugin '{}': {}", plugin_id, e)))?;
            let config_json = serde_json::to_value(config)
                .map_err(|e| DbError::ConfigError(e.to_string()))?;
            Ok(Box::new(PluginDriver::new(client, plugin_id.clone(), config_json).await?))
        }
        DatabaseType::PostgreSQL => {
            Ok(Box::new(PostgresConnection::new(config).await?))
        }
        DatabaseType::GaussDB => {
            // Tier 1: tokio-gaussdb (Huawei official, binary protocol)
            match GaussAsyncConnection::new(config).await {
                Ok(conn) => {
                    log::info!("GaussDB connected via tokio-gaussdb (binary protocol)");
                    return Ok(Box::new(conn));
                }
                Err(e) => log::warn!("tokio-gaussdb failed: {}, trying sqlx fallback...", e),
            }
            // Tier 2: sqlx PG driver
            if let Ok(conn) = PgCompatibleConnection::new(config, DialectConfig::gaussdb()).await {
                log::info!("GaussDB connected via sqlx PG driver (fallback)");
                return Ok(Box::new(conn));
            }
            Err(DbError::ConnectionError("All GaussDB drivers failed".into()))
        }
        // PG-compatible: use dialect-specific PgCompatibleConnection
        DatabaseType::Kingbase => {
            Ok(Box::new(PgCompatibleConnection::new(config, DialectConfig::kingbase()).await?))
        }
        DatabaseType::Vastbase => {
            Ok(Box::new(PgCompatibleConnection::new(config, DialectConfig::vastbase()).await?))
        }
        DatabaseType::MySQL => Ok(Box::new(MySqlConnection::new(config).await?)),
        // MySQL-compatible: use MySqlConnection as provisional driver
        DatabaseType::OceanBase
        | DatabaseType::TiDB
        | DatabaseType::TDSQL => Ok(Box::new(MySqlConnection::new(config).await?)),
        DatabaseType::SQLite => Ok(Box::new(SQLiteConnection::new(config).await?)),
        DatabaseType::ClickHouse => {
            Ok(Box::new(ClickHouseConnection::new(config).await?))
        }
        DatabaseType::SQLServer => Ok(Box::new(SqlServerConnection::new(config).await?)),
        DatabaseType::Oracle | DatabaseType::DaMeng | DatabaseType::YashanDB | DatabaseType::GBase => {
            if super::native::use_jdbc(&config.db_type)? {
                Ok(Box::new(JdbcConnection::new(config).await?))
            } else {
                Ok(Box::new(super::native::NativeConnection::connect(config).await?))
            }
        }
        DatabaseType::Redis => {
            Ok(Box::new(super::redis_native::RedisConnection::new(config).await?))
        }
        DatabaseType::MongoDB => {
            Ok(Box::new(super::mongo_native::MongoConnection::new(config).await?))
        }
    }
}

pub(super) async fn prepare_transport(config: &ConnectionConfig) -> Result<(ConnectionConfig, Option<crate::ssh::tunnel::SshTunnel>), DbError> {
    let mut effective_config = config.clone();

    let ssh_tunnel = if let Some(ref ssh) = config.ssh_tunnel {
        let target_host = config.host.as_deref().unwrap_or("localhost");
        let target_port = config.port.unwrap_or(config.db_type.default_port());
        let ssh_cfg = crate::ssh::tunnel::SshConfig {
            host: ssh.host.clone(),
            port: ssh.port,
            username: ssh.username.clone(),
            password: Some(ssh.password.clone()),
            private_key: ssh.private_key.clone(),
        };
        log::info!("Setting up SSH tunnel to {}:{}", target_host, target_port);
        let tunnel = crate::ssh::tunnel::SshTunnel::connect(&ssh_cfg, target_host, target_port).await?;
        let local_port = tunnel.local_addr.port();
        effective_config.host = Some("127.0.0.1".to_string());
        effective_config.port = Some(local_port);
        Some(tunnel)
    } else {
        None
    };
    Ok((effective_config, ssh_tunnel))
}
