use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::{Path, PathBuf}, process::Stdio, time::Duration};
use tokio::{io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader}, process::{Child, ChildStdin, ChildStdout, Command}, sync::Mutex};
use super::{trait_def::{sanitize_order_by, DatabaseConnection}, types::*};

const MAX_FRAME: u64 = 16 * 1024 * 1024;
const SOURCE: &str = include_str!("../../../../../packages/jdbc-bridge/CrabHubJdbc.java");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    driver: String,
    jar: String,
    url_template: String,
    dialect: String,
    #[serde(default)]
    properties: BTreeMap<String, String>,
    #[serde(default)]
    extra_jars: Vec<String>,
}

impl Profile {
    fn load(directory: &Path, kind: &DatabaseType) -> Result<Self, DbError> {
        let path = directory.join(format!("{}.json", kind.as_str()));
        if path.is_file() {
            let bytes = std::fs::read(&path).map_err(|error| DbError::ConfigError(error.to_string()))?;
            return serde_json::from_slice(&bytes).map_err(|error| DbError::ConfigError(format!("Invalid JDBC profile {}: {error}", path.display())));
        }
        let built_in = match kind {
            DatabaseType::Oracle => include_str!("../../../../../packages/jdbc-bridge/profiles/oracle.json"),
            DatabaseType::DaMeng => include_str!("../../../../../packages/jdbc-bridge/profiles/dameng.json"),
            DatabaseType::YashanDB => include_str!("../../../../../packages/jdbc-bridge/profiles/yashandb.json"),
            DatabaseType::GBase => include_str!("../../../../../packages/jdbc-bridge/profiles/gbase.json"),
            _ => return Err(DbError::ConfigError("No JDBC profile for this database type".into())),
        };
        serde_json::from_str(built_in).map_err(|error| DbError::ConfigError(format!("Invalid built-in JDBC profile: {error}")))
    }

    fn url(&self, config: &ConnectionConfig) -> Result<String, DbError> {
        if !self.url_template.starts_with("jdbc:") || !["oracle", "dameng", "yashandb", "mysql", "generic"].contains(&self.dialect.as_str()) {
            return Err(DbError::ConfigError("Invalid JDBC URL template or dialect.".into()));
        }
        if self.url_template.to_lowercase().contains("password=") || self.url_template.to_lowercase().contains("user=")
            || self.properties.keys().any(|key| ["user", "username", "password", "pwd"].contains(&key.to_lowercase().as_str())) {
            return Err(DbError::ConfigError("Do not store credentials in a JDBC profile URL.".into()));
        }
        let host = config.host.as_deref().unwrap_or("localhost");
        if host.is_empty() || !host.chars().all(|character| character.is_ascii_alphanumeric() || ".-_:[]".contains(character)) {
            return Err(DbError::ConfigError("Use a hostname or IP address, not a connection URL.".into()));
        }
        let host = if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_owned() };
        let database = config.database.as_deref().unwrap_or("");
        if self.url_template.contains("{database}") && database.is_empty() {
            return Err(DbError::ConfigError("A database name is required for this JDBC driver.".into()));
        }
        if !database.chars().all(|character| character.is_alphanumeric() || "_-.".contains(character)) {
            return Err(DbError::ConfigError("Invalid JDBC database name.".into()));
        }
        let url = self.url_template.replace("{host}", &host).replace("{port}", &config.port.unwrap_or(config.db_type.default_port()).to_string()).replace("{database}", database);
        if url.contains(['{', '}', '\0', '\n', '\r']) { return Err(DbError::ConfigError("Unresolved JDBC URL placeholder.".into())); }
        Ok(url)
    }
}

struct Worker {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    sequence: u64,
    _directory: tempfile::TempDir,
}

impl Worker {
    async fn exchange(&mut self, method: &str, params: Value) -> Result<Value, DbError> {
        self.sequence += 1;
        let mut request = serde_json::to_vec(&json!({"id": self.sequence, "method": method, "params": params})).map_err(|error| DbError::Internal(error.to_string()))?;
        if request.len() as u64 >= MAX_FRAME { return Err(DbError::QueryError("JDBC request exceeds 16 MiB.".into())); }
        request.push(b'\n');
        self.stdin.write_all(&request).await.map_err(|_| DbError::ConnectionError("JDBC process input closed; reconnect.".into()))?;
        self.stdin.flush().await.map_err(|_| DbError::ConnectionError("JDBC process input closed; reconnect.".into()))?;
        let mut bytes = Vec::new();
        (&mut self.stdout).take(MAX_FRAME + 1).read_until(b'\n', &mut bytes).await.map_err(|_| DbError::ConnectionError("JDBC process output closed; reconnect.".into()))?;
        if bytes.is_empty() || bytes.last() != Some(&b'\n') || bytes.len() as u64 > MAX_FRAME {
            return Err(DbError::ConnectionError("JDBC process exited or returned an oversized frame. Check JDK 17+ and vendor JAR compatibility; reconnect.".into()));
        }
        let response: Value = serde_json::from_slice(&bytes).map_err(|_| DbError::ConnectionError("Invalid JDBC response; reconnect.".into()))?;
        if response["id"].as_u64() != Some(self.sequence) { return Err(DbError::ConnectionError("JDBC response sequence mismatch; reconnect.".into())); }
        Ok(response)
    }
}

pub struct JdbcConnection {
    worker: Mutex<Option<Worker>>,
    kind: DatabaseType,
    timeout: Option<Duration>,
    password: String,
    url: String,
}

impl JdbcConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        if config.ssl_enabled {
            return Err(DbError::ConfigError("JDBC TLS options have not been validated for this vendor. Plaintext fallback is disabled.".into()));
        }
        let directory = std::env::var_os("CRABHUB_JDBC_DIR").map(PathBuf::from).or_else(|| dirs::data_local_dir().map(|path| path.join("CrabHub/jdbc")))
            .ok_or_else(|| DbError::ConfigError("Set CRABHUB_JDBC_DIR to the vendor JAR directory.".into()))?;
        let profile = Profile::load(&directory, &config.db_type)?;
        let url = profile.url(config)?;
        let mut jars = vec![directory.join("gson.jar"), directory.join(&profile.jar)];
        jars.extend(profile.extra_jars.iter().map(|jar| directory.join(jar)));
        for jar in &jars {
            if !jar.is_file() { return Err(DbError::ConfigError(format!("Missing JDBC dependency: {}. Run packages/jdbc-bridge/setup.ps1, or install the official vendor JAR.", jar.display()))); }
        }
        let jars = jars.into_iter().map(std::fs::canonicalize).collect::<Result<Vec<_>, _>>().map_err(|error| DbError::ConfigError(error.to_string()))?;
        let classpath = std::env::join_paths(jars).map_err(|error| DbError::ConfigError(error.to_string()))?;
        let source_directory = tempfile::tempdir().map_err(|error| DbError::Internal(error.to_string()))?;
        let source_path = source_directory.path().join("CrabHubJdbc.java");
        std::fs::write(&source_path, SOURCE).map_err(|error| DbError::Internal(error.to_string()))?;
        let java = std::env::var_os("JAVA_HOME").map(|home| PathBuf::from(home).join(if cfg!(windows) { "bin/java.exe" } else { "bin/java" })).unwrap_or_else(|| "java".into());
        let mut command = Command::new(java);
        command.args(["-Xmx256m", "-Dfile.encoding=UTF-8", "--class-path"]).arg(classpath).arg("--source").arg("17").arg(source_path)
            .env_remove("JAVA_TOOL_OPTIONS").env_remove("JDK_JAVA_OPTIONS").env_remove("_JAVA_OPTIONS")
            .current_dir(source_directory.path()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|error| DbError::ConfigError(format!("Cannot launch Java. Install JDK 17+ or set JAVA_HOME: {error}")))?;
        let stdin = child.stdin.take().ok_or_else(|| DbError::Internal("Missing JDBC input pipe".into()))?;
        let stdout = BufReader::new(child.stdout.take().ok_or_else(|| DbError::Internal("Missing JDBC output pipe".into()))?);
        let connection = Self { worker: Mutex::new(Some(Worker { child, stdin, stdout, sequence: 0, _directory: source_directory })), kind: config.db_type.clone(),
            timeout: (config.query_timeout_secs != 0).then(|| Duration::from_secs(config.query_timeout_secs.saturating_add(5))), password: config.password.clone().unwrap_or_default(), url: url.clone() };
        tokio::time::timeout(Duration::from_secs(30), connection.call::<Value>("connect", json!({"driver": profile.driver, "url": url,
            "username": config.username, "password": config.password, "database": config.database, "dialect": profile.dialect,
            "properties": profile.properties, "timeout": config.query_timeout_secs.min(i32::MAX as u64)})))
            .await.map_err(|_| DbError::Timeout("JDBC login timed out.".into()))??;
        Ok(connection)
    }

    async fn call<ResultType: DeserializeOwned>(&self, method: &str, params: Value) -> Result<ResultType, DbError> {
        let mut slot = self.worker.lock().await;
        let mut worker = slot.take().ok_or_else(|| DbError::ConnectionError("JDBC session closed or cancelled; reconnect before retrying. Writes are never automatically replayed.".into()))?;
        let response = if let Some(timeout) = self.timeout {
            tokio::time::timeout(timeout, worker.exchange(method, params)).await.map_err(|_| DbError::Timeout("JDBC request timed out; reconnect and check database state before retrying.".into()))??
        } else {
            worker.exchange(method, params).await?
        };
        if response["fatal"].as_bool() != Some(true) { *slot = Some(worker); }
        if let Some(error) = response["error"].as_str() {
            let error = error.replace(&self.url, "[JDBC URL]");
            let error = if self.password.is_empty() { error } else { error.replace(&self.password, "[redacted]") };
            return Err(DbError::QueryError(error));
        }
        serde_json::from_value(response["result"].clone()).map_err(|error| DbError::Internal(format!("Invalid JDBC result shape: {error}")))
    }
}

#[async_trait]
impl DatabaseConnection for JdbcConnection {
    fn db_type(&self) -> DatabaseType { self.kind.clone() }
    fn handles_query_pagination(&self) -> bool { true }
    async fn database_names(&self) -> Result<Option<Vec<String>>, DbError> { self.call("databases", json!({})).await.map(Some) }
    async fn ping(&self) -> Result<(), DbError> { self.call::<bool>("ping", json!({})).await.map(|_| ()) }
    async fn close(&self) { if let Some(mut worker) = self.worker.lock().await.take() { let _ = worker.child.kill().await; } }
    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> { self.call("execute", json!({"sql": sql})).await }
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> { self.call("query", json!({"sql": sql})).await }
    async fn query_sql_paged(&self, sql: &str, limit: u64, offset: u64) -> Result<(QueryResult, bool), DbError> {
        if limit == 0 || limit >= 20000 || offset > i32::MAX as u64 - limit - 1 {
            return Err(DbError::QueryError("JDBC page requires 1-19999 rows and an offset within the JDBC integer range.".into()));
        }
        let mut result: QueryResult = self.call("query_paged", json!({"sql": sql, "offset": offset, "limit": limit + 1})).await?;
        let has_more = result.rows.len() as u64 > limit;
        result.rows.truncate(limit as usize);
        result.row_count = result.rows.len() as u64;
        Ok((result, has_more))
    }
    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> { self.call("tables", json!({})).await }
    async fn get_schemas(&self) -> Result<Vec<String>, DbError> { self.call("schemas", json!({})).await }
    async fn get_columns(&self, table: &str, schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> { self.call("columns", json!({"table": table, "schema": schema})).await }
    async fn get_views(&self, schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> { self.call("views", json!({"schema": schema})).await }
    async fn get_indexes(&self, table: &str, schema: Option<&str>) -> Result<Vec<Value>, DbError> { self.call("indexes", json!({"table": table, "schema": schema})).await }
    async fn get_foreign_keys(&self, table: &str, schema: Option<&str>) -> Result<Vec<Value>, DbError> { self.call("foreign_keys", json!({"table": table, "schema": schema})).await }
    async fn export_table_sql(&self, table: &str, schema: Option<&str>) -> Result<String, DbError> { self.call("ddl", json!({"table": table, "schema": schema})).await }
    async fn get_table_row_count(&self, table: &str, schema: Option<&str>) -> Result<u64, DbError> { self.call("count", json!({"table": table, "schema": schema})).await }
    async fn get_table_data(&self, table: &str, schema: Option<&str>, page: u32, page_size: u32, order_by: Option<&str>) -> Result<QueryResult, DbError> {
        let order = sanitize_order_by(order_by.unwrap_or("1"))?;
        self.call("data", json!({"table": table, "schema": schema, "page": page, "pageSize": page_size, "orderBy": order})).await
    }
    async fn update_table_rows(&self, table: &str, schema: Option<&str>, updates: &[(String, Value)], where_conditions: &[WhereCondition]) -> Result<ExecuteResult, DbError> {
        if where_conditions.is_empty() { return Err(DbError::QueryError("WHERE conditions are required.".into())); }
        self.call("update", json!({"table": table, "schema": schema, "values": updates, "conditions": where_conditions})).await
    }
    async fn insert_table_row(&self, table: &str, schema: Option<&str>, values: &[(String, Value)]) -> Result<ExecuteResult, DbError> {
        self.call("insert", json!({"table": table, "schema": schema, "values": values})).await
    }
    async fn delete_table_rows(&self, table: &str, schema: Option<&str>, where_conditions: &[WhereCondition]) -> Result<ExecuteResult, DbError> {
        if where_conditions.is_empty() { return Err(DbError::QueryError("WHERE conditions are required.".into())); }
        self.call("delete", json!({"table": table, "schema": schema, "conditions": where_conditions})).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn built_in_vendor_profiles_use_their_own_drivers() {
        let directory = tempfile::tempdir().unwrap();
        let profile = Profile::load(directory.path(), &DatabaseType::DaMeng).unwrap();
        assert_eq!(profile.driver, "dm.jdbc.driver.DmDriver");
        assert_eq!(profile.url_template, "jdbc:dm://{host}:{port}");
        assert_eq!(Profile::load(directory.path(), &DatabaseType::GBase).unwrap().driver, "com.gbasedbt.jdbc.Driver");
        assert_eq!(Profile::load(directory.path(), &DatabaseType::YashanDB).unwrap().driver, "com.yashandb.jdbc.Driver");
        let oracle = Profile::load(directory.path(), &DatabaseType::Oracle).unwrap();
        assert_eq!(oracle.driver, "oracle.jdbc.OracleDriver");
        assert_eq!(oracle.url_template, "jdbc:oracle:thin:@//{host}:{port}/{database}");
    }

    #[test]
    fn malformed_profile_is_not_silently_replaced() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("dameng.json"), "{}").unwrap();
        assert!(Profile::load(directory.path(), &DatabaseType::DaMeng).is_err());
    }

    fn oracle_config(database: Option<&str>) -> ConnectionConfig {
        serde_json::from_value(json!({
            "id": "oracle-profile", "name": "Oracle profile",
            "dbType": "oracle", "host": "db.example", "database": database,
            "username": "APP", "password": "fixture-password"
        })).unwrap()
    }

    #[test]
    fn oracle_service_url_keeps_credentials_out_of_the_url() {
        let directory = tempfile::tempdir().unwrap();
        let profile = Profile::load(directory.path(), &DatabaseType::Oracle).unwrap();
        assert_eq!(profile.url(&oracle_config(Some("sales.example"))).unwrap(), "jdbc:oracle:thin:@//db.example:1521/sales.example");
        let mut config = oracle_config(Some("FREEPDB1"));
        config.host = Some("::1".into());
        config.port = Some(1522);
        assert_eq!(profile.url(&config).unwrap(), "jdbc:oracle:thin:@//[::1]:1522/FREEPDB1");
    }

    #[test]
    fn oracle_rejects_missing_service_and_url_options_in_service_field() {
        let directory = tempfile::tempdir().unwrap();
        let profile = Profile::load(directory.path(), &DatabaseType::Oracle).unwrap();
        for service in [None, Some(""), Some("service?user=other"), Some("service/extra"), Some("service\n") ] {
            assert!(profile.url(&oracle_config(service)).is_err());
        }
    }

    #[test]
    fn oracle_sid_profile_is_an_explicit_override() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("oracle.json"), json!({
            "driver": "oracle.jdbc.OracleDriver", "jar": "oracle.jar",
            "urlTemplate": "jdbc:oracle:thin:@{host}:{port}:{database}", "dialect": "oracle"
        }).to_string()).unwrap();
        let profile = Profile::load(directory.path(), &DatabaseType::Oracle).unwrap();
        assert_eq!(profile.url(&oracle_config(Some("ORCL"))).unwrap(), "jdbc:oracle:thin:@db.example:1521:ORCL");
    }
}