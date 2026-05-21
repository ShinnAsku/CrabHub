use crate::db::types::DatabaseType;

pub struct PoolConfig {
    pub max_connections: u32,
    pub idle_timeout_secs: u64,
    pub max_lifetime_secs: u64,
    pub acquire_timeout_secs: u64,
}

pub fn pool_config_for(db_type: &DatabaseType) -> PoolConfig {
    match db_type {
        DatabaseType::SQLite => PoolConfig {
            max_connections: 1,
            idle_timeout_secs: 300,
            max_lifetime_secs: 1800,
            acquire_timeout_secs: 10,
        },
        DatabaseType::PostgreSQL
        | DatabaseType::GaussDB
        | DatabaseType::Kingbase
        | DatabaseType::Vastbase
        | DatabaseType::YashanDB => PoolConfig {
            max_connections: 10,
            idle_timeout_secs: 600,
            max_lifetime_secs: 1800,
            acquire_timeout_secs: 10,
        },
        DatabaseType::MySQL
        | DatabaseType::OceanBase
        | DatabaseType::TiDB
        | DatabaseType::TDSQL => PoolConfig {
            max_connections: 10,
            idle_timeout_secs: 600,
            max_lifetime_secs: 1800,
            acquire_timeout_secs: 10,
        },
        DatabaseType::ClickHouse
        | DatabaseType::Oracle
        | DatabaseType::SQLServer
        | DatabaseType::DaMeng
        | DatabaseType::GBase
        | DatabaseType::Plugin(_) => PoolConfig {
            max_connections: 5,
            idle_timeout_secs: 600,
            max_lifetime_secs: 1800,
            acquire_timeout_secs: 30,
        },
    }
}
