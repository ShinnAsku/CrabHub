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
        DatabaseType::PostgreSQL | DatabaseType::GaussDB => PoolConfig {
            max_connections: 10,
            idle_timeout_secs: 600,
            max_lifetime_secs: 1800,
            acquire_timeout_secs: 10,
        },
        DatabaseType::MySQL => PoolConfig {
            max_connections: 10,
            idle_timeout_secs: 600,
            max_lifetime_secs: 1800,
            acquire_timeout_secs: 10,
        },
        DatabaseType::ClickHouse | DatabaseType::Plugin(_) => PoolConfig {
            max_connections: 5,
            idle_timeout_secs: 600,
            max_lifetime_secs: 1800,
            acquire_timeout_secs: 30,
        },
    }
}
