//! Native MongoDB driver (official `mongodb` crate).
//!
//! Mapping onto the generic `DatabaseConnection` surface:
//!   - schemas → databases
//!   - tables → collections (+ estimated document count)
//!   - columns → top-level fields sampled from one document
//!   - table data → find() with skip/limit; documents flattened so每个顶层
//!     字段一列，嵌套值渲染为 JSON
//!   - query_sql → mongo-shell 风格：`db.<coll>.find({...})`,
//!     `db.<coll>.aggregate([...])`, `db.<coll>.count({...})`,
//!     `show collections`

use async_trait::async_trait;
use mongodb::bson::{doc, Bson, Document};
use mongodb::Client;
use serde_json::{json, Map, Value};

use super::trait_def::DatabaseConnection;
use super::types::{
    ColumnInfo, ConnectionConfig, DatabaseType, DbError, ExecuteResult, QueryResult, TableInfo,
};

pub struct MongoConnection {
    client: Client,
    /// Default database from the connection profile.
    database: String,
}

impl MongoConnection {
    pub async fn new(config: &ConnectionConfig) -> Result<Self, DbError> {
        let host = config.host.as_deref().unwrap_or("localhost");
        // Full mongodb:// or mongodb+srv:// URIs pasted into the host field
        // are honored as-is (Atlas / replica sets).
        let uri = if host.starts_with("mongodb://") || host.starts_with("mongodb+srv://") {
            host.to_string()
        } else {
            let port = config.port.unwrap_or(27017);
            let auth = match (config.username.as_deref(), config.password.as_deref()) {
                (Some(u), Some(p)) if !u.is_empty() => {
                    format!("{}:{}@", urlencoding::encode(u), urlencoding::encode(p))
                }
                _ => String::new(),
            };
            format!("mongodb://{}{}:{}/", auth, host, port)
        };

        log::info!("Connecting to MongoDB at {}", host);
        let client = Client::with_uri_str(&uri)
            .await
            .map_err(|e| DbError::ConnectionError(format!("MongoDB: {}", e)))?;
        let database = config.database.clone().filter(|d| !d.is_empty()).unwrap_or_else(|| "admin".into());

        // Fail fast with a clear error instead of on first real operation.
        client
            .database(&database)
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(|e| DbError::ConnectionError(format!("MongoDB ping: {}", e)))?;
        log::info!("Successfully connected to MongoDB");
        Ok(Self { client, database })
    }

    fn bson_to_json(b: &Bson) -> Value {
        match b {
            Bson::ObjectId(oid) => json!(oid.to_hex()),
            Bson::DateTime(dt) => json!(dt.try_to_rfc3339_string().unwrap_or_else(|_| dt.to_string())),
            Bson::Decimal128(d) => json!(d.to_string()),
            other => serde_json::to_value(other.clone().into_relaxed_extjson()).unwrap_or(Value::Null),
        }
    }

    /// Flatten a document: top-level fields become columns; nested values stay JSON.
    fn doc_to_row(doc: &Document) -> Map<String, Value> {
        let mut m = Map::new();
        for (k, v) in doc {
            m.insert(k.clone(), Self::bson_to_json(v));
        }
        m
    }

    fn docs_to_result(docs: Vec<Document>, elapsed_ms: u64) -> QueryResult {
        // Union of keys across the page keeps ragged documents displayable.
        let mut col_order: Vec<String> = Vec::new();
        for d in &docs {
            for k in d.keys() {
                if !col_order.iter().any(|c| c == k) {
                    col_order.push(k.clone());
                }
            }
        }
        let columns = col_order
            .iter()
            .map(|name| ColumnInfo {
                name: name.clone(),
                data_type: "bson".to_string(),
                nullable: true,
                is_primary_key: name == "_id",
                default_value: None,
                comment: None,
                character_maximum_length: None,
                numeric_precision: None,
                numeric_scale: None,
            })
            .collect();
        let rows: Vec<Map<String, Value>> = docs.iter().map(Self::doc_to_row).collect();
        let row_count = rows.len() as u64;
        QueryResult { columns, rows, row_count, execution_time_ms: elapsed_ms }
    }

    fn parse_json_arg(arg: &str) -> Result<Document, DbError> {
        let trimmed = arg.trim();
        if trimmed.is_empty() {
            return Ok(Document::new());
        }
        let v: Value = serde_json::from_str(trimmed)
            .map_err(|e| DbError::QueryError(format!("JSON 参数无效: {}", e)))?;
        mongodb::bson::to_document(&v).map_err(|e| DbError::QueryError(format!("BSON: {}", e)))
    }
}

/// Parsed mongo-shell style statement.
enum MongoStmt {
    Find { coll: String, filter: Document },
    Aggregate { coll: String, pipeline: Vec<Document> },
    Count { coll: String, filter: Document },
    InsertOne { coll: String, doc: Document },
    DeleteMany { coll: String, filter: Document },
    ShowCollections,
}

fn parse_stmt(sql: &str) -> Result<MongoStmt, DbError> {
    let s = sql.trim().trim_end_matches(';').trim();
    if s.eq_ignore_ascii_case("show collections") || s.eq_ignore_ascii_case("show tables") {
        return Ok(MongoStmt::ShowCollections);
    }
    let re = regex::Regex::new(r"(?s)^db\.([\w.-]+)\.(find|aggregate|count|countDocuments|insertOne|deleteMany)\s*\((.*)\)$").unwrap();
    let caps = re.captures(s).ok_or_else(|| {
        DbError::QueryError(
            "支持的语法: db.<collection>.find({...}) / aggregate([...]) / count({...}) / insertOne({...}) / deleteMany({...}) / show collections".into(),
        )
    })?;
    let coll = caps[1].to_string();
    let arg = caps[3].trim().to_string();
    match &caps[2] {
        "find" => Ok(MongoStmt::Find { coll, filter: MongoConnection::parse_json_arg(&arg)? }),
        "aggregate" => {
            let v: Value = if arg.is_empty() { json!([]) } else {
                serde_json::from_str(&arg).map_err(|e| DbError::QueryError(format!("pipeline JSON 无效: {}", e)))?
            };
            let stages = v.as_array().ok_or_else(|| DbError::QueryError("aggregate 参数必须是数组".into()))?;
            let pipeline = stages
                .iter()
                .map(|s| mongodb::bson::to_document(s).map_err(|e| DbError::QueryError(format!("BSON: {}", e))))
                .collect::<Result<Vec<_>, _>>()?;
            Ok(MongoStmt::Aggregate { coll, pipeline })
        }
        "count" | "countDocuments" => Ok(MongoStmt::Count { coll, filter: MongoConnection::parse_json_arg(&arg)? }),
        "insertOne" => Ok(MongoStmt::InsertOne { coll, doc: MongoConnection::parse_json_arg(&arg)? }),
        "deleteMany" => Ok(MongoStmt::DeleteMany { coll, filter: MongoConnection::parse_json_arg(&arg)? }),
        _ => unreachable!(),
    }
}

#[async_trait]
impl DatabaseConnection for MongoConnection {
    async fn query_sql(&self, sql: &str) -> Result<QueryResult, DbError> {
        use futures_util::TryStreamExt;
        let start = std::time::Instant::now();
        let db = self.client.database(&self.database);
        match parse_stmt(sql)? {
            MongoStmt::Find { coll, filter } => {
                let docs: Vec<Document> = db
                    .collection::<Document>(&coll)
                    .find(filter)
                    .limit(500)
                    .await
                    .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?
                    .try_collect()
                    .await
                    .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
                Ok(Self::docs_to_result(docs, start.elapsed().as_millis() as u64))
            }
            MongoStmt::Aggregate { coll, pipeline } => {
                let docs: Vec<Document> = db
                    .collection::<Document>(&coll)
                    .aggregate(pipeline)
                    .await
                    .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?
                    .try_collect()
                    .await
                    .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
                Ok(Self::docs_to_result(docs, start.elapsed().as_millis() as u64))
            }
            MongoStmt::Count { coll, filter } => {
                let n = db
                    .collection::<Document>(&coll)
                    .count_documents(filter)
                    .await
                    .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
                Ok(Self::docs_to_result(vec![doc! { "count": n as i64 }], start.elapsed().as_millis() as u64))
            }
            MongoStmt::ShowCollections => {
                let names = db
                    .list_collection_names()
                    .await
                    .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
                let docs = names.into_iter().map(|n| doc! { "collection": n }).collect();
                Ok(Self::docs_to_result(docs, start.elapsed().as_millis() as u64))
            }
            MongoStmt::InsertOne { .. } | MongoStmt::DeleteMany { .. } => {
                Err(DbError::QueryError("写操作请用「执行」而不是「查询」".into()))
            }
        }
    }

    async fn execute_sql(&self, sql: &str) -> Result<ExecuteResult, DbError> {
        let start = std::time::Instant::now();
        let db = self.client.database(&self.database);
        let affected = match parse_stmt(sql)? {
            MongoStmt::InsertOne { coll, doc } => {
                db.collection::<Document>(&coll)
                    .insert_one(doc)
                    .await
                    .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
                1
            }
            MongoStmt::DeleteMany { coll, filter } => {
                db.collection::<Document>(&coll)
                    .delete_many(filter)
                    .await
                    .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?
                    .deleted_count
            }
            _ => return Err(DbError::QueryError("读操作请用「查询」执行".into())),
        };
        Ok(ExecuteResult { rows_affected: affected, execution_time_ms: start.elapsed().as_millis() as u64 })
    }

    fn db_type(&self) -> DatabaseType {
        DatabaseType::MongoDB
    }

    async fn close(&self) { /* client drops with self */ }

    async fn get_schemas(&self) -> Result<Vec<String>, DbError> {
        self.client
            .list_database_names()
            .await
            .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))
    }

    async fn get_tables(&self) -> Result<Vec<TableInfo>, DbError> {
        let db = self.client.database(&self.database);
        let names = db
            .list_collection_names()
            .await
            .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
        let mut tables = Vec::with_capacity(names.len());
        for name in names {
            let count = db
                .collection::<Document>(&name)
                .estimated_document_count()
                .await
                .ok();
            tables.push(TableInfo {
                name,
                schema: Some(self.database.clone()),
                row_count: count,
                comment: None,
                table_type: "COLLECTION".into(),
                oid: None, owner: None, acl: None, primary_key: Some("_id".into()),
                partition_of: None, has_indexes: None, has_triggers: None,
                engine: None, data_length: None, create_time: None,
                update_time: None, collation: None,
            });
        }
        Ok(tables)
    }

    /// Sample one document to expose top-level fields as columns.
    async fn get_columns(&self, table: &str, _schema: Option<&str>) -> Result<Vec<ColumnInfo>, DbError> {
        let db = self.client.database(&self.database);
        let sample = db
            .collection::<Document>(table)
            .find_one(Document::new())
            .await
            .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
        let Some(doc) = sample else { return Ok(vec![]) };
        Ok(doc
            .iter()
            .map(|(k, v)| ColumnInfo {
                name: k.clone(),
                data_type: bson_type_name(v).to_string(),
                nullable: true,
                is_primary_key: k == "_id",
                default_value: None,
                comment: None,
                character_maximum_length: None,
                numeric_precision: None,
                numeric_scale: None,
            })
            .collect())
    }

    async fn get_table_data(
        &self,
        table: &str,
        _schema: Option<&str>,
        page: u32,
        page_size: u32,
        _order_by: Option<&str>,
    ) -> Result<QueryResult, DbError> {
        use futures_util::TryStreamExt;
        let start = std::time::Instant::now();
        let db = self.client.database(&self.database);
        let skip = ((page.saturating_sub(1)) as u64) * page_size as u64;
        let docs: Vec<Document> = db
            .collection::<Document>(table)
            .find(Document::new())
            .skip(skip)
            .limit(page_size as i64)
            .await
            .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?
            .try_collect()
            .await
            .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
        Ok(Self::docs_to_result(docs, start.elapsed().as_millis() as u64))
    }

    async fn get_table_row_count(&self, table: &str, _schema: Option<&str>) -> Result<u64, DbError> {
        self.client
            .database(&self.database)
            .collection::<Document>(table)
            .estimated_document_count()
            .await
            .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))
    }

    async fn export_table_sql(&self, table: &str, _schema: Option<&str>) -> Result<String, DbError> {
        Ok(format!("-- MongoDB collection: {}.{}\n-- Use mongodump/mongoexport for schema-level export\n", self.database, table))
    }

    async fn get_views(&self, _schema: Option<&str>) -> Result<Vec<TableInfo>, DbError> {
        Ok(vec![])
    }

    async fn get_indexes(&self, table: &str, _schema: Option<&str>) -> Result<Vec<Value>, DbError> {
        use futures_util::TryStreamExt;
        let indexes: Vec<mongodb::IndexModel> = self
            .client
            .database(&self.database)
            .collection::<Document>(table)
            .list_indexes()
            .await
            .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?
            .try_collect()
            .await
            .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
        Ok(indexes
            .into_iter()
            .map(|ix| {
                json!({
                    "index_name": ix.options.and_then(|o| o.name).unwrap_or_default(),
                    "index_def": Self::bson_to_json(&Bson::Document(ix.keys)),
                })
            })
            .collect())
    }

    async fn get_foreign_keys(&self, _t: &str, _s: Option<&str>) -> Result<Vec<Value>, DbError> {
        Ok(vec![])
    }

    async fn update_table_rows(
        &self, _t: &str, _s: Option<&str>,
        _u: &[(String, Value)],
        _w: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        Err(DbError::QueryError("MongoDB 请使用 db.<collection>.updateMany 语法（后续版本支持行内编辑）".into()))
    }

    async fn insert_table_row(
        &self, table: &str, _s: Option<&str>, values: &[(String, Value)],
    ) -> Result<ExecuteResult, DbError> {
        let start = std::time::Instant::now();
        let mut doc = Document::new();
        for (k, v) in values {
            doc.insert(
                k,
                mongodb::bson::to_bson(v).map_err(|e| DbError::QueryError(format!("BSON: {}", e)))?,
            );
        }
        self.client
            .database(&self.database)
            .collection::<Document>(table)
            .insert_one(doc)
            .await
            .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
        Ok(ExecuteResult { rows_affected: 1, execution_time_ms: start.elapsed().as_millis() as u64 })
    }

    async fn delete_table_rows(
        &self, table: &str, _s: Option<&str>,
        where_conditions: &[crate::db::types::WhereCondition],
    ) -> Result<ExecuteResult, DbError> {
        let start = std::time::Instant::now();
        let mut filter = Document::new();
        for cond in where_conditions {
            filter.insert(
                &cond.column,
                mongodb::bson::to_bson(&cond.value).map_err(|e| DbError::QueryError(format!("BSON: {}", e)))?,
            );
        }
        if filter.is_empty() {
            return Err(DbError::QueryError("拒绝无条件删除，请提供筛选条件".into()));
        }
        let r = self
            .client
            .database(&self.database)
            .collection::<Document>(table)
            .delete_many(filter)
            .await
            .map_err(|e| DbError::QueryError(format!("MongoDB: {}", e)))?;
        Ok(ExecuteResult { rows_affected: r.deleted_count, execution_time_ms: start.elapsed().as_millis() as u64 })
    }
}

fn bson_type_name(b: &Bson) -> &'static str {
    match b {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Int32(_) => "int32",
        Bson::Int64(_) => "int64",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Decimal128(_) => "decimal128",
        Bson::Null => "null",
        _ => "bson",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_find_statement() {
        let stmt = parse_stmt(r#"db.users.find({"age": {"$gt": 18}})"#).unwrap();
        match stmt {
            MongoStmt::Find { coll, filter } => {
                assert_eq!(coll, "users");
                assert!(filter.contains_key("age"));
            }
            _ => panic!("expected find"),
        }
    }

    #[test]
    fn parses_aggregate_and_show() {
        assert!(matches!(
            parse_stmt(r#"db.orders.aggregate([{"$group": {"_id": "$status"}}])"#).unwrap(),
            MongoStmt::Aggregate { .. }
        ));
        assert!(matches!(parse_stmt("show collections").unwrap(), MongoStmt::ShowCollections));
    }

    #[test]
    fn rejects_unknown_syntax() {
        assert!(parse_stmt("SELECT * FROM users").is_err());
    }
}
