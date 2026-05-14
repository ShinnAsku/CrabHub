use async_trait::async_trait;
use std::time::Instant;

use super::trait_def::{json_value_to_sql, DatabaseConnection};
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

// ============================================================================
// Driver Layer: TLS Support for tokio_gaussdb
// ============================================================================

struct GaussDbTlsConnector(native_tls::TlsConnector);

impl<S> tokio_gaussdb::tls::MakeTlsConnect<S> for GaussDbTlsConnector
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    type Stream = GaussDbTlsStream<S>;
    type TlsConnect = GaussDbTlsConnect;
    type Error = std::io::Error;

    fn make_tls_connect(&mut self, _domain: &str) -> Result<Self::TlsConnect, Self::Error> {
        Ok(GaussDbTlsConnect(self.0.clone()))
    }
}

struct GaussDbTlsConnect(native_tls::TlsConnector);

impl<S> tokio_gaussdb::tls::TlsConnect<S> for GaussDbTlsConnect
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    type Stream = GaussDbTlsStream<S>;
    type Error = std::io::Error;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Self::Stream, Self::Error>> + Send>,
    >;

    fn connect(self, stream: S) -> Self::Future {
        Box::pin(async move {
            let tls_stream = tokio_native_tls::TlsConnector::from(self.0)
                .connect("gaussdb", stream)
                .await
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            Ok(GaussDbTlsStream(tls_stream))
        })
    }
}

struct GaussDbTlsStream<S>(tokio_native_tls::TlsStream<S>);

impl<S> tokio::io::AsyncRead for GaussDbTlsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl<S> tokio::io::AsyncWrite for GaussDbTlsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

impl<S> tokio_gaussdb::tls::TlsStream for GaussDbTlsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    fn channel_binding(&self) -> tokio_gaussdb::tls::ChannelBinding {
        tokio_gaussdb::tls::ChannelBinding::none()
    }
}

// ============================================================================
// Driver Layer: TLS Support for tokio_opengauss
// ============================================================================

struct OpenGaussTlsConnector(native_tls::TlsConnector);

impl<S> tokio_opengauss::tls::MakeTlsConnect<S> for OpenGaussTlsConnector
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    type Stream = OpenGaussTlsStream<S>;
    type TlsConnect = OpenGaussTlsConnect;
    type Error = std::io::Error;

    fn make_tls_connect(&mut self, _domain: &str) -> Result<Self::TlsConnect, Self::Error> {
        Ok(OpenGaussTlsConnect(self.0.clone()))
    }
}

struct OpenGaussTlsConnect(native_tls::TlsConnector);

impl<S> tokio_opengauss::tls::TlsConnect<S> for OpenGaussTlsConnect
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    type Stream = OpenGaussTlsStream<S>;
    type Error = std::io::Error;
    type Future = std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Self::Stream, Self::Error>> + Send>,
    >;

    fn connect(self, stream: S) -> Self::Future {
        Box::pin(async move {
            let tls_stream = tokio_native_tls::TlsConnector::from(self.0)
                .connect("opengauss", stream)
                .await
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            Ok(OpenGaussTlsStream(tls_stream))
        })
    }
}

struct OpenGaussTlsStream<S>(tokio_native_tls::TlsStream<S>);

impl<S> tokio::io::AsyncRead for OpenGaussTlsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl<S> tokio::io::AsyncWrite for OpenGaussTlsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}

impl<S> tokio_opengauss::tls::TlsStream for OpenGaussTlsStream<S>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    fn channel_binding(&self) -> tokio_opengauss::tls::ChannelBinding {
        tokio_opengauss::tls::ChannelBinding::none()
    }
}

// ============================================================================
// Driver Layer: Text Protocol Value Conversion
// ============================================================================

/// Convert a text-protocol string value to JSON, using the PostgreSQL type name
/// to guide parsing. The simple_query protocol returns ALL values as text strings,
/// which avoids the binary FromSql limitation that caused NULL for non-text types
/// (date, time, timestamp, uuid, inet, macaddr, interval, geometric, arrays, etc.).
fn text_to_json_value(text: &str, type_name: &str) -> serde_json::Value {
    match type_name {
        "bool" => serde_json::Value::Bool(text == "t" || text == "true"),
        "int2" | "int4" | "int8" | "int1" | "oid" | "smallint" | "integer" | "bigint"
        | "smallserial" | "serial" | "bigserial" => {
            serde_json::Value::String(text.to_string())
        }
        "float4" | "float8" | "real" | "double precision" => {
            if let Ok(f) = text.parse::<f64>() {
                serde_json::Number::from_f64(f)
                    .map(serde_json::Value::Number)
                    .unwrap_or_else(|| serde_json::Value::String(text.to_string()))
            } else {
                serde_json::Value::String(text.to_string())
            }
        }
        "numeric" | "money" => serde_json::Value::String(text.to_string()),
        "json" | "jsonb" => serde_json::from_str(text)
            .unwrap_or_else(|_| serde_json::Value::String(text.to_string())),
        // Everything else: text, varchar, bpchar, bytea, date, time, timetz,
        // timestamp, timestamptz, interval, uuid, inet, cidr, macaddr,
        // point, lseg, box, path, polygon, circle, tsvector, tsquery,
        // arrays (_int4, _text, etc.), xml, name, etc.
        _ => serde_json::Value::String(text.to_string()),
    }
}

// ============================================================================
// Driver Layer: Simple Query Result Builder
// ============================================================================

/// Macro to build query results from simple_query messages.
/// Uses a two-phase approach:
///   Phase 1: client.prepare() to get column type metadata (extended protocol)
///   Phase 2: client.simple_query() to get data as text (text protocol)
/// This avoids binary FromSql limitations while preserving column type info.
macro_rules! simple_query_to_results {
    ($client:expr, $sql:expr, $sqm_row:path) => {{
        // Phase 1: Get column type metadata via prepare (extended protocol).
        // prepare() only parses/describes, doesn't execute. If it fails
        // (e.g. multi-statement SQL), we fall back to "text" as data_type.
        let col_types: Vec<(String, String)> = match $client.prepare($sql).await {
            Ok(stmt) => stmt
                .columns()
                .iter()
                .map(|c| (c.name().to_string(), c.type_().name().to_string()))
                .collect(),
            Err(_) => Vec::new(),
        };

        // Phase 2: Get data via simple_query (text protocol).
        // All values come back as Option<&str>, no FromSql needed.
        let messages = $client
            .simple_query($sql)
            .await
            .map_err(|e| DbError::QueryError(e.to_string()))?;
        let mut columns: Vec<ColumnInfo> = Vec::new();
        let mut rows: Vec<serde_json::Map<String, serde_json::Value>> = Vec::new();
        let mut cols_extracted = false;
        for msg in messages {
            if let $sqm_row(row) = msg {
                if !cols_extracted {
                    columns = row
                        .columns()
                        .iter()
                        .enumerate()
                        .map(|(i, c)| {
                            let data_type = col_types
                                .get(i)
                                .map(|(_, t)| t.clone())
                                .unwrap_or_else(|| "text".to_string());
                            ColumnInfo {
                                name: c.name().to_string(),
                                data_type,
                                nullable: true,
                                is_primary_key: false,
                                default_value: None,
                                comment: None,
                                character_maximum_length: None,
                                numeric_precision: None,
                                numeric_scale: None,
                            }
                        })
                        .collect();
                    cols_extracted = true;
                }
                let mut map = serde_json::Map::new();
                for (idx, _col) in row.columns().iter().enumerate() {
                    let col_name = row.columns()[idx].name();
                    let type_name = col_types
                        .get(idx)
                        .map(|(_, t)| t.as_str())
                        .unwrap_or("text");
                    let value = match row.get(idx) {
                        Some(text) => text_to_json_value(text, type_name),
                        None => serde_json::Value::Null,
                    };
                    map.insert(col_name.to_string(), value);
                }
                rows.push(map);
            }
        }
        Ok((columns, rows))
    }};
}

// ============================================================================
// Driver Layer: Client Abstraction
// ============================================================================

enum GaussClient {
    GaussDB(tokio_gaussdb::Client),
    OpenGauss(tokio_opengauss::Client),
}

impl GaussClient {
    async fn execute(&self, sql: &str) -> Result<u64, DbError> {
        match self {
            GaussClient::GaussDB(c) => c
                .execute(sql, &[])
                .await
                .map_err(|e| DbError::QueryError(e.to_string())),
            GaussClient::OpenGauss(c) => c
                .execute(sql, &[])
                .await
                .map_err(|e| DbError::QueryError(e.to_string())),
        }
    }

    async fn query_to_results(
        &self,
        sql: &str,
    ) -> Result<
        (
            Vec<ColumnInfo>,
            Vec<serde_json::Map<String, serde_json::Value>>,
        ),
        DbError,
    > {
        match self {
            GaussClient::GaussDB(client) => {
                simple_query_to_results!(
                    client,
                    sql,
                    tokio_gaussdb::SimpleQueryMessage::Row
                )
            }
            GaussClient::OpenGauss(client) => {
                simple_query_to_results!(
                    client,
                    sql,
                    tokio_opengauss::SimpleQueryMessage::Row
                )
            }
        }
    }

    fn driver_name(&self) -> &str {
        match self {
            GaussClient::GaussDB(_) => "tokio_gaussdb",
            GaussClient::OpenGauss(_) => "tokio_opengauss",
        }
    }
}

// ============================================================================
// Business Layer: GaussDBConnection
// ============================================================================

pub struct GaussDBConnection {
    client: GaussClient,
    db_type_label: DatabaseType,
}

impl GaussDBConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        let host = config.host.as_deref().unwrap_or("localhost");
        let port = config.port.unwrap_or(8000);
        let default_username = "gaussdb";
        let username = config.username.as_deref().unwrap_or(default_username);
        let password = config.password.as_deref().unwrap_or("");
        let database = config.database.as_deref().unwrap_or("");
        let ssl_mode = if config.ssl_enabled {
            "require"
        } else {
            "prefer"
        };

        let mut conn_parts = vec![
            format!("host={}", host),
            format!("port={}", port),
            format!("user={}", username),
            format!("sslmode={}", ssl_mode),
        ];
        if !password.is_empty() {
            conn_parts.push(format!("password={}", password));
        }
        if !database.is_empty() {
            conn_parts.push(format!("dbname={}", database));
        }
        let connection_string = conn_parts.join(" ");

        log::info!("Connecting to GaussDB/openGauss at {}:{}", host, port);

        // Try tokio_gaussdb first, fall back to tokio_opengauss on failure
        let client =
            match Self::try_connect_gaussdb(&connection_string, config.ssl_enabled).await {
                Ok(c) => {
                    log::info!("Connected via tokio_gaussdb driver");
                    GaussClient::GaussDB(c)
                }
                Err(gaussdb_err) => {
                    log::warn!(
                        "tokio_gaussdb failed: {}, trying tokio_opengauss...",
                        gaussdb_err
                    );
                    match Self::try_connect_opengauss(&connection_string, config.ssl_enabled).await
                    {
                        Ok(c) => {
                            log::info!("Connected via tokio_opengauss driver");
                            GaussClient::OpenGauss(c)
                        }
                        Err(og_err) => {
                            return Err(DbError::ConnectionError(format!(
                                "Failed to connect to GaussDB/openGauss.\n  tokio_gaussdb: {}\n  tokio_opengauss: {}",
                                gaussdb_err, og_err
                            )));
                        }
                    }
                }
            };

        log::info!(
            "Successfully connected via {} driver",
            client.driver_name()
        );

        let db_type_label = Self::detect_server_type(&client, config.db_type.clone()).await;
        log::info!("Detected server type: {:?}", db_type_label);

        Ok(Self {
            client,
            db_type_label,
        })
    }

    async fn try_connect_gaussdb(
        conn_str: &str,
        ssl: bool,
    ) -> Result<tokio_gaussdb::Client, String> {
        if ssl {
            let tls_connector =
                native_tls::TlsConnector::new().map_err(|e| format!("TLS error: {}", e))?;
            let tls = GaussDbTlsConnector(tls_connector);
            let (client, connection) =
                tokio_gaussdb::connect(conn_str, tls)
                    .await
                    .map_err(|e| e.to_string())?;
            tokio::spawn(async move {
                if let Err(e) = connection.await {
                    log::error!("tokio_gaussdb connection task error: {}", e);
                }
            });
            Ok(client)
        } else {
            let (client, connection) = tokio_gaussdb::connect(conn_str, tokio_gaussdb::NoTls)
                .await
                .map_err(|e| e.to_string())?;
            tokio::spawn(async move {
                if let Err(e) = connection.await {
                    log::error!("tokio_gaussdb connection task error: {}", e);
                }
            });
            Ok(client)
        }
    }

    async fn try_connect_opengauss(
        conn_str: &str,
        ssl: bool,
    ) -> Result<tokio_opengauss::Client, String> {
        if ssl {
            let tls_connector =
                native_tls::TlsConnector::new().map_err(|e| format!("TLS error: {}", e))?;
            let tls = OpenGaussTlsConnector(tls_connector);
            let (client, connection) = tokio_opengauss::connect(conn_str, tls)
                .await
                .map_err(|e| e.to_string())?;
            tokio::spawn(async move {
                if let Err(e) = connection.await {
                    log::error!("tokio_opengauss connection task error: {}", e);
                }
            });
            Ok(client)
        } else {
            let (client, connection) =
                tokio_opengauss::connect(conn_str, tokio_opengauss::NoTls)
                    .await
                    .map_err(|e| e.to_string())?;
            tokio::spawn(async move {
                if let Err(e) = connection.await {
                    log::error!("tokio_opengauss connection task error: {}", e);
                }
            });
            Ok(client)
        }
    }

    async fn detect_server_type(client: &GaussClient, fallback: DatabaseType) -> DatabaseType {
        match client.query_to_results("SELECT version()").await {
            Ok((_, rows)) => {
                if let Some(row) = rows.first() {
                    if let Some(serde_json::Value::String(version_str)) = row.values().next() {
                        let lower = version_str.to_lowercase();
                        if lower.contains("opengauss") {
                            log::info!(
                                "Server version: {} -> detected as openGauss",
                                version_str
                            );
                            return DatabaseType::GaussDB;
                        } else if lower.contains("gaussdb") {
                            log::info!(
                                "Server version: {} -> detected as GaussDB",
                                version_str
                            );
                            return DatabaseType::GaussDB;
                        }
                        log::info!(
                            "Server version: {} -> using fallback {:?}",
                            version_str,
                            fallback
                        );
                    }
                }
                fallback
            }
            Err(e) => {
                log::warn!(
                    "Failed to detect server type: {}, using fallback {:?}",
                    e,
                    fallback
                );
                fallback
            }
        }
    }
}

// ============================================================================
// Helpers
// ============================================================================

fn gaussdb_full_table(table: &str, schema: Option<&str>) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("\"{}\".\"{}\"", s, table),
        _ => format!("\"{}\"", table),
    }
}

fn escape_sql_string(s: &str) -> String {
    s.replace('\'', "''")
}

/// Helper to extract a string from a JSON row value.
fn row_str(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> String {
    row.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn row_str_opt(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
    row.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn row_bool(row: &serde_json::Map<String, serde_json::Value>, key: &str) -> bool {
    row.get(key)
        .map(|v| {
            v.as_bool().unwrap_or_else(|| {
                v.as_str()
                    .map(|s| s == "t" || s == "true")
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

// ============================================================================
// Business Layer: DatabaseConnection trait implementation
// ============================================================================

#[async_trait]
impl DatabaseConnection for GaussDBConnection {
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let start = Instant::now();
        let rows_affected = self.client.execute(sql).await?;
        Ok(ExecuteResult {
            rows_affected,
            execution_time_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        let start = Instant::now();
        let (columns, rows) = self.client.query_to_results(sql).await?;
        let row_count = rows.len() as u64;
        Ok(QueryResult {
            columns,
            rows,
            row_count,
            execution_time_ms: start.elapsed().as_millis() as u64,
        })
    }

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let sql = r#"
            SELECT
                t.table_name,
                t.table_schema,
                t.table_type
            FROM information_schema.tables t
            WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY t.table_schema, t.table_name
        "#;

        let (_, rows) = self.client.query_to_results(sql).await?;
        let tables = rows
            .iter()
            .map(|row| {
                let table_type = row_str(row, "table_type");
                let table_type = if table_type == "BASE TABLE" {
                    "TABLE".to_string()
                } else {
                    table_type
                };
                TableInfo {
                    name: row_str(row, "table_name"),
                    schema: row_str_opt(row, "table_schema"),
                    row_count: None,
                    comment: None,
                    table_type,
                    oid: None,
                    owner: None,
                    acl: None,
                    primary_key: None,
                    partition_of: None,
                    has_indexes: None,
                    has_triggers: None,
                    engine: None,
                    data_length: None,
                    create_time: None,
                    update_time: None,
                    collation: None,
                }
            })
            .collect();

        Ok(tables)
    }

    async fn get_columns(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<ColumnInfo>, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = format!(
            r#"
            SELECT
                c.column_name,
                c.data_type,
                c.is_nullable,
                c.column_default,
                c.character_maximum_length,
                c.numeric_precision,
                c.numeric_scale,
                CASE
                    WHEN pk.column_name IS NOT NULL THEN true
                    ELSE false
                END as is_primary_key
            FROM information_schema.columns c
            LEFT JOIN (
                SELECT
                    kcu.table_schema,
                    kcu.table_name,
                    kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                    AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
            ) pk ON pk.table_schema = c.table_schema
                AND pk.table_name = c.table_name
                AND pk.column_name = c.column_name
            WHERE c.table_name = '{}' AND c.table_schema = '{}'
            ORDER BY c.ordinal_position
            "#,
            escape_sql_string(table),
            escape_sql_string(schema_name)
        );

        let (_, rows) = self.client.query_to_results(&sql).await?;
        let columns = rows
            .iter()
            .map(|row| {
                let is_nullable = row_str(row, "is_nullable");
                let char_max_len = row_str_opt(row, "character_maximum_length")
                    .and_then(|s| s.parse::<i64>().ok());
                let num_precision = row_str_opt(row, "numeric_precision")
                    .and_then(|s| s.parse::<i64>().ok());
                let num_scale = row_str_opt(row, "numeric_scale")
                    .and_then(|s| s.parse::<i64>().ok());
                ColumnInfo {
                    name: row_str(row, "column_name"),
                    data_type: row_str(row, "data_type"),
                    nullable: is_nullable == "YES",
                    is_primary_key: row_bool(row, "is_primary_key"),
                    default_value: row_str_opt(row, "column_default"),
                    comment: None,
                    character_maximum_length: char_max_len,
                    numeric_precision: num_precision,
                    numeric_scale: num_scale,
                }
            })
            .collect();

        Ok(columns)
    }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        let sql = r#"
            SELECT schema_name
            FROM information_schema.schemata
            WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
            ORDER BY schema_name
        "#;

        let (_, rows) = self.client.query_to_results(sql).await?;
        let schemas = rows.iter().map(|row| row_str(row, "schema_name")).collect();
        Ok(schemas)
    }

    fn db_type(&self) -> DatabaseType {
        self.db_type_label.clone()
    }

    async fn export_table_sql(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<String, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = format!(
            "SELECT column_name, data_type, is_nullable, column_default \
             FROM information_schema.columns \
             WHERE table_name = '{}' AND table_schema = '{}' \
             ORDER BY ordinal_position",
            escape_sql_string(table),
            escape_sql_string(schema_name)
        );

        let (_, rows) = self.client.query_to_results(&sql).await?;

        let col_defs: Vec<String> = rows
            .iter()
            .map(|row| {
                let name = row_str(row, "column_name");
                let data_type = row_str(row, "data_type");
                let is_nullable = row_str(row, "is_nullable");
                let default = row_str_opt(row, "column_default");
                let null_str = if is_nullable == "YES" {
                    ""
                } else {
                    " NOT NULL"
                };
                let default_str = match default {
                    Some(d) => format!(" DEFAULT {}", d),
                    None => String::new(),
                };
                format!("    {} {}{}{}", name, data_type, null_str, default_str)
            })
            .collect();

        let full_table = if schema_name == "public" {
            table.to_string()
        } else {
            format!("{}.{}", schema_name, table)
        };

        Ok(format!(
            "-- Table: {}\nCREATE TABLE IF NOT EXISTS {} (\n{}\n);\n",
            full_table,
            full_table,
            col_defs.join(",\n")
        ))
    }

    async fn close(&self) {
        log::info!(
            "Closing GaussDB/openGauss connection (driver: {})",
            self.client.driver_name()
        );
        // Client is dropped when GaussDBConnection is dropped,
        // which signals the background connection task to stop.
    }

    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        let schema_filter = match schema {
            Some(s) => format!("AND table_schema = '{}'", escape_sql_string(s)),
            None => String::new(),
        };
        let sql = format!(
            "SELECT table_name, table_schema, 'VIEW' as table_type \
             FROM information_schema.views \
             WHERE table_schema NOT IN ('pg_catalog', 'information_schema') \
             {} ORDER BY table_schema, table_name",
            schema_filter
        );
        let (_, rows) = self.client.query_to_results(&sql).await?;
        let views = rows
            .iter()
            .map(|row| TableInfo {
                name: row_str(row, "table_name"),
                schema: row_str_opt(row, "table_schema"),
                row_count: None,
                comment: None,
                table_type: "VIEW".to_string(),
                oid: None,
                owner: None,
                acl: None,
                primary_key: None,
                partition_of: None,
                has_indexes: None,
                has_triggers: None,
                engine: None,
                data_length: None,
                create_time: None,
                update_time: None,
                collation: None,
            })
            .collect();
        Ok(views)
    }

    async fn get_indexes(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = format!(
            "SELECT index_name, is_unique, is_primary, column_names FROM (\
                SELECT i.relname as index_name, ix.indisunique as is_unique, \
                ix.indisprimary as is_primary, \
                array_to_string(array_agg(a.attname), ', ') as column_names \
                FROM pg_class t JOIN pg_index ix ON t.oid = ix.indrelid \
                JOIN pg_class i ON i.oid = ix.indexrelid \
                JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
                JOIN pg_namespace n ON n.oid = t.relnamespace \
                WHERE t.relname = '{}' AND n.nspname = '{}' \
                GROUP BY i.relname, ix.indisunique, ix.indisprimary\
            ) sub ORDER BY index_name",
            escape_sql_string(table),
            escape_sql_string(schema_name)
        );
        let result = self.query_sql(&sql).await?;
        Ok(result
            .rows
            .into_iter()
            .map(|m| serde_json::Value::Object(m))
            .collect())
    }

    async fn get_foreign_keys(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<Vec<serde_json::Value>, DbError> {
        let schema_name = schema.unwrap_or("public");
        let sql = format!(
            r#"
            SELECT
                tc.constraint_name,
                kcu.column_name,
                ccu.table_schema as foreign_table_schema,
                ccu.table_name as foreign_table_name,
                ccu.column_name as foreign_column_name
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
                ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage AS ccu
                ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = '{}' AND tc.table_schema = '{}'
            "#,
            escape_sql_string(table),
            escape_sql_string(schema_name)
        );
        let result = self.query_sql(&sql).await?;
        Ok(result
            .rows
            .into_iter()
            .map(|m| serde_json::Value::Object(m))
            .collect())
    }

    async fn get_table_row_count(
        &self,
        table: &str,
        schema: Option<&str>,
    ) -> Result<u64, DbError> {
        let full_table = gaussdb_full_table(table, schema);
        let sql = format!("SELECT COUNT(*) as cnt FROM {}", full_table);
        let (_, rows) = self.client.query_to_results(&sql).await?;
        if let Some(row) = rows.first() {
            if let Some(cnt) = row
                .get("cnt")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<u64>().ok())
            {
                return Ok(cnt);
            }
        }
        Ok(0)
    }

    async fn get_table_data(
        &self,
        table: &str,
        schema: Option<&str>,
        page: u32,
        page_size: u32,
        order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        let full_table = gaussdb_full_table(table, schema);
        let order_clause = order_by
            .map(|o| format!(" ORDER BY {}", o))
            .unwrap_or_default();
        let offset = (page - 1) * page_size;
        let sql = format!(
            "SELECT * FROM {}{} LIMIT {} OFFSET {}",
            full_table, order_clause, page_size, offset
        );
        let mut result = self.query_sql(&sql).await?;
        if result.columns.is_empty() {
            result.columns = self.get_columns(table, schema).await.unwrap_or_default();
        }
        Ok(result)
    }

    async fn update_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        updates: &[(String, serde_json::Value)],
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        let full_table = gaussdb_full_table(table, schema);
        let set_clauses: Vec<String> = updates
            .iter()
            .map(|(col, val)| format!("{} = {}", col, json_value_to_sql(val)))
            .collect();
        let sql = format!(
            "UPDATE {} SET {} WHERE {}",
            full_table,
            set_clauses.join(", "),
            where_clause
        );
        self.execute_sql(&sql).await
    }

    async fn insert_table_row(
        &self,
        table: &str,
        schema: Option<&str>,
        values: &[(String, serde_json::Value)],
    ) -> Result<ExecuteResult, DbError> {
        let full_table = gaussdb_full_table(table, schema);
        let columns: Vec<&str> = values.iter().map(|(c, _)| c.as_str()).collect();
        let value_strs: Vec<String> =
            values.iter().map(|(_, val)| json_value_to_sql(val)).collect();
        let sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            full_table,
            columns.join(", "),
            value_strs.join(", ")
        );
        self.execute_sql(&sql).await
    }

    async fn delete_table_rows(
        &self,
        table: &str,
        schema: Option<&str>,
        where_clause: &str,
    ) -> Result<ExecuteResult, DbError> {
        let full_table = gaussdb_full_table(table, schema);
        let sql = format!("DELETE FROM {} WHERE {}", full_table, where_clause);
        self.execute_sql(&sql).await
    }
}
