//! Native Redis driver (redis-rs, multiplexed async connection).
//!
//! Maps Redis onto the generic `DatabaseConnection` surface so the existing
//! UI (sidebar tree, object list, table view, query editor) works without a
//! dedicated browser:
//!   - schemas         → db0..db15 (logical databases)
//!   - tables          → keys (SCAN-limited), table_type = redis value type
//!   - table data      → the key's value rendered as rows (hash → field/value,
//!                       list → index/value, zset → member/score, ...)
//!   - query_sql       → raw Redis command line ("GET user:1", "SCAN 0", ...)

use async_trait::async_trait;
use redis::aio::ConnectionManager as RedisConn;
use serde_json::{json, Map, Value};

use super::trait_def::DatabaseConnection;
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

/// Keys listed in the sidebar are capped to keep SCAN cheap on huge keyspaces.
const KEY_SCAN_LIMIT: usize = 1000;

pub struct RedisConnection {
    conn: RedisConn,
}

impl RedisConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(6379);
        let auth = match (config.username.as_deref(), config.password.as_deref()) {
            (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => {
                format!("{}:{}@", urlencoding::encode(u), urlencoding::encode(p))
            }
            (_, Some(p)) if !p.is_empty() => format!(":{}@", urlencoding::encode(p)),
            _ => String::new(),
        };
        let db_index = config
            .database
            .as_deref()
            .and_then(|d| d.trim_start_matches("db").parse::<u32>().ok())
            .unwrap_or(0);
        let url = format!("redis://{}{}:{}/{}", auth, host, port, db_index);

        log::info!("Connecting to Redis at {}:{} (db{})", host, port, db_index);
        let client = redis::Client::open(url)
            .map_err(|e| DbError::ConnectionError(format!("Redis: {}", e)))?;
        let conn = RedisConn::new(client)
            .await
            .map_err(|e| DbError::ConnectionError(format!("Redis: {}", e)))?;
        log::info!("Successfully connected to Redis");
        Ok(Self { conn })
    }

    /// Split a command line into arguments, honoring single/double quotes.
    fn split_command(input: &str) -> Vec<String> {
        let mut args = Vec::new();
        let mut cur = String::new();
        let mut quote: Option<char> = None;
        for ch in input.chars() {
            match (ch, quote) {
                (q @ ('"' | '\''), None) => quote = Some(q),
                (q, Some(open)) if q == open => quote = None,
                (c, None) if c.is_whitespace() => {
                    if !cur.is_empty() {
                        args.push(std::mem::take(&mut cur));
                    }
                }
                (c, _) => cur.push(c),
            }
        }
        if !cur.is_empty() {
            args.push(cur);
        }
        args
    }

    fn value_to_json(v: &redis::Value) -> Value {
        match v {
            redis::Value::Nil => Value::Null,
            redis::Value::Int(i) => json!(i),
            redis::Value::Double(d) => json!(d),
            redis::Value::Boolean(b) => json!(b),
            redis::Value::SimpleString(s) => json!(s),
            redis::Value::BulkString(bytes) => match std::str::from_utf8(bytes) {
                Ok(s) => json!(s),
                Err(_) => json!(format!("<binary {} bytes>", bytes.len())),
            },
            redis::Value::Array(items) | redis::Value::Set(items) => {
                Value::Array(items.iter().map(Self::value_to_json).collect())
            }
            redis::Value::Map(pairs) => {
                let mut m = Map::new();
                for (k, v) in pairs {
                    let key = match Self::value_to_json(k) {
                        Value::String(s) => s,
                        other => other.to_string(),
                    };
                    m.insert(key, Self::value_to_json(v));
                }
                Value::Object(m)
            }
            other => json!(format!("{:?}", other)),
        }
    }

    fn col(name: &str) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            data_type: "text".to_string(),
            nullable: true,
            is_primary_key: false,
            default_value: None,
            comment: None,
            character_maximum_length: None,
            numeric_precision: None,
            numeric_scale: None,
        }
    }

    /// Render an arbitrary command reply as a result grid.
    fn reply_to_result(reply: Value, elapsed_ms: u64) -> QueryResult {
        let mut rows: Vec<Map<String, Value>> = Vec::new();
        match reply {
            Value::Array(items) => {
                for (i, item) in items.into_iter().enumerate() {
                    let mut m = Map::new();
                    m.insert("#".into(), json!(i + 1));
                    m.insert("value".into(), item);
                    rows.push(m);
                }
            }
            Value::Object(obj) => {
                for (k, v) in obj {
                    let mut m = Map::new();
                    m.insert("field".into(), json!(k));
                    m.insert("value".into(), v);
                    rows.push(m);
                }
            }
            other => {
                let mut m = Map::new();
                m.insert("value".into(), other);
                rows.push(m);
            }
        }
        let columns = rows
            .first()
            .map(|r| r.keys().map(|k| Self::col(k)).collect())
            .unwrap_or_else(|| vec![Self::col("value")]);
        let row_count = rows.len() as u64;
        QueryResult { columns, rows, row_count, execution_time_ms: elapsed_ms }
    }

    async fn run(&self, args: &[String]) -> Result<redis::Value, DbError> {
        if args.is_empty() {
            return Err(DbError::QueryError("Empty Redis command".into()));
        }
        let mut cmd = redis::cmd(&args[0]);
        for a in &args[1..] {
            cmd.arg(a);
        }
        cmd.query_async(&mut self.conn.clone())
            .await
            .map_err(|e| DbError::QueryError(format!("Redis: {}", e)))
    }
}

#[async_trait]
impl DatabaseConnection for RedisConnection {
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let start = std::time::Instant::now();
        let args = Self::split_command(sql.trim().trim_end_matches(';'));
        let reply = self.run(&args).await?;
        Ok(Self::reply_to_result(
            Self::value_to_json(&reply),
            start.elapsed().as_millis() as u64,
        ))
    }

    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let start = std::time::Instant::now();
        let args = Self::split_command(sql.trim().trim_end_matches(';'));
        self.run(&args).await?;
        Ok(ExecuteResult { rows_affected: 1, execution_time_ms: start.elapsed().as_millis() as u64 })
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::Redis
    }

    async fn close(&self) { /* multiplexed connection drops with self */ }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        // Logical databases; most deployments use 16.
        Ok((0..16).map(|i| format!("db{}", i)).collect())
    }

    /// Keys as "tables": name + redis type so the object list is browsable.
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let mut cursor: u64 = 0;
        let mut keys: Vec<String> = Vec::new();
        loop {
            let reply = self
                .run(&["SCAN".into(), cursor.to_string(), "COUNT".into(), "500".into()])
                .await?;
            if let redis::Value::Array(parts) = reply {
                if parts.len() == 2 {
                    if let Value::String(c) = Self::value_to_json(&parts[0]) {
                        cursor = c.parse().unwrap_or(0);
                    }
                    if let Value::Array(items) = Self::value_to_json(&parts[1]) {
                        keys.extend(items.into_iter().filter_map(|v| v.as_str().map(String::from)));
                    }
                }
            }
            if cursor == 0 || keys.len() >= KEY_SCAN_LIMIT {
                break;
            }
        }
        keys.truncate(KEY_SCAN_LIMIT);
        keys.sort();

        let mut tables = Vec::with_capacity(keys.len());
        for key in keys {
            let key_type = match self.run(&["TYPE".into(), key.clone()]).await {
                Ok(v) => match Self::value_to_json(&v) {
                    Value::String(s) => s,
                    _ => "unknown".into(),
                },
                Err(_) => "unknown".into(),
            };
            tables.push(TableInfo {
                name: key,
                schema: None,
                row_count: None,
                comment: None,
                table_type: key_type.to_uppercase(),
                oid: None, owner: None, acl: None, primary_key: None,
                partition_of: None, has_indexes: None, has_triggers: None,
                engine: None, data_length: None, create_time: None,
                update_time: None, collation: None,
            });
        }
        Ok(tables)
    }

    async fn get_columns(&self, table: &str, _schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let key_type = match Self::value_to_json(&self.run(&["TYPE".into(), table.into()]).await?) {
            Value::String(s) => s,
            _ => "string".into(),
        };
        let cols = match key_type.as_str() {
            "hash" => vec!["field", "value"],
            "list" => vec!["index", "value"],
            "zset" => vec!["member", "score"],
            "set" => vec!["member"],
            "stream" => vec!["id", "fields"],
            _ => vec!["value"],
        };
        Ok(cols.into_iter().map(Self::col).collect())
    }

    /// Render a key's contents as rows (paged client-side; Redis values are
    /// fetched whole — acceptable for a management UI's default page sizes).
    async fn get_table_data(
        &self,
        table: &str,
        _schema: Option<&str>,
        page: u32,
        page_size: u32,
        _order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        let start = std::time::Instant::now();
        let key_type = match Self::value_to_json(&self.run(&["TYPE".into(), table.into()]).await?) {
            Value::String(s) => s,
            _ => "string".into(),
        };
        let reply = match key_type.as_str() {
            "hash" => self.run(&["HGETALL".into(), table.into()]).await?,
            "list" => self.run(&["LRANGE".into(), table.into(), "0".into(), "-1".into()]).await?,
            "set" => self.run(&["SMEMBERS".into(), table.into()]).await?,
            "zset" => self.run(&["ZRANGE".into(), table.into(), "0".into(), "-1".into(), "WITHSCORES".into()]).await?,
            _ => self.run(&["GET".into(), table.into()]).await?,
        };
        let mut result = Self::reply_to_result(Self::value_to_json(&reply), start.elapsed().as_millis() as u64);
        // Client-side pagination
        let from = ((page.saturating_sub(1)) * page_size) as usize;
        let to = (from + page_size as usize).min(result.rows.len());
        result.rows = if from < result.rows.len() { result.rows[from..to].to_vec() } else { vec![] };
        result.row_count = result.rows.len() as u64;
        Ok(result)
    }

    async fn get_table_row_count(&self, table: &str, _schema: Option<&str>) -> Result<u64, DbError> {
        let key_type = match Self::value_to_json(&self.run(&["TYPE".into(), table.into()]).await?) {
            Value::String(s) => s,
            _ => "string".into(),
        };
        let cmd: Vec<String> = match key_type.as_str() {
            "hash" => vec!["HLEN".into(), table.into()],
            "list" => vec!["LLEN".into(), table.into()],
            "set" => vec!["SCARD".into(), table.into()],
            "zset" => vec!["ZCARD".into(), table.into()],
            _ => return Ok(1),
        };
        match Self::value_to_json(&self.run(&cmd).await?) {
            Value::Number(n) => Ok(n.as_u64().unwrap_or(0)),
            _ => Ok(0),
        }
    }

    async fn export_table_sql(&self, table: &str, _schema: Option<&str>) -> Result<String, DbError> {
        Ok(format!("-- Redis key: {}\n-- Use DUMP/RESTORE or redis-cli --rdb for persistence-level export\n", table))
    }

    async fn get_views(&self, _schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        Ok(vec![])
    }

    async fn get_indexes(&self, _t: &str, _s: Option<&str>) -> Result<Vec<Value>, DbError> {
        Ok(vec![])
    }

    async fn get_foreign_keys(&self, _t: &str, _s: Option<&str>) -> Result<Vec<Value>, DbError> {
        Ok(vec![])
    }

    async fn update_table_rows(
        &self, _t: &str, _s: Option<&str>,
        _u: &[(String, Value)],
        _w: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        Err(DbError::QueryError("Redis 请使用命令行操作（HSET / LSET / SET ...）".into()))
    }

    async fn insert_table_row(
        &self, _t: &str, _s: Option<&str>, _v: &[(String, Value)],
    ) -> Result<ExecuteResult, DbError> {
        Err(DbError::QueryError("Redis 请使用命令行操作（SET / HSET / RPUSH ...）".into()))
    }

    async fn delete_table_rows(
        &self, table: &str, _s: Option<&str>,
        _w: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        let start = std::time::Instant::now();
        self.run(&["DEL".into(), table.into()]).await?;
        Ok(ExecuteResult { rows_affected: 1, execution_time_ms: start.elapsed().as_millis() as u64 })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_command_handles_quotes() {
        assert_eq!(
            RedisConnection::split_command(r#"SET greeting "hello world""#),
            vec!["SET", "greeting", "hello world"]
        );
        assert_eq!(
            RedisConnection::split_command("HGET user:1 name"),
            vec!["HGET", "user:1", "name"]
        );
        assert_eq!(
            RedisConnection::split_command("SET k 'a b'"),
            vec!["SET", "k", "a b"]
        );
    }
}
