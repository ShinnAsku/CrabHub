use super::*;
use ::oracle::sql_type::{OracleType, ToSql};
use base64::Engine;
use std::io::Read;

pub(super) struct Client(::oracle::Connection);

impl Client {
    pub(super) fn connect(config: &ConnectionConfig) -> Result<Self, DbError> {
        let service = config
            .database
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DbError::ConfigError("Oracle Service Name is required".into()))?;
        if !service
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-$#".contains(character))
        {
            return Err(DbError::ConfigError("Invalid Oracle Service Name".into()));
        }
        let descriptor = format!("(DESCRIPTION=(CONNECT_TIMEOUT=15)(TRANSPORT_CONNECT_TIMEOUT=15)(RETRY_COUNT=0)(ADDRESS=(PROTOCOL=TCP)(HOST={})(PORT={}))(CONNECT_DATA=(SERVICE_NAME={})))", host(config)?, config.port.unwrap_or(1521), service);
        let mut connection = ::oracle::Connection::connect(config.username.as_deref().unwrap_or(""), config.password.as_deref().unwrap_or(""), descriptor)
            .map_err(|error| DbError::ConnectionError(format!("Oracle native client: {error}. Install matching Oracle Instant Client Basic and add its directory to the native library search path")))?;
        connection.set_autocommit(true);
        connection
            .set_call_timeout(
                (config.query_timeout_secs != 0)
                    .then(|| Duration::from_secs(config.query_timeout_secs)),
            )
            .map_err(native_error)?;
        Ok(Self(connection))
    }
}

impl NativeClient for Client {
    fn run(&mut self, request: &Request) -> Result<QueryResult, DbError> {
        let start = Instant::now();
        let parameters: Vec<Box<dyn ToSql>> = request
            .params
            .iter()
            .map(|value| match value {
                Value::Null => Box::new(None::<String>) as Box<dyn ToSql>,
                Value::Bool(value) => Box::new(i32::from(*value)),
                Value::Number(value) => Box::new(value.to_string()),
                Value::String(value) => Box::new(value.clone()),
                value => Box::new(value.to_string()),
            })
            .collect();
        let parameters: Vec<&dyn ToSql> = parameters.iter().map(|value| value.as_ref()).collect();
        let mut result = empty_result(start);
        if let Some((limit, offset)) = request.window {
            let mut statement = self
                .0
                .statement(&request.sql)
                .fetch_array_size(32)
                .prefetch_rows(0)
                .lob_locator()
                .build()
                .map_err(native_error)?;
            let rows = statement.query(&parameters).map_err(native_error)?;
            result.columns = rows
                .column_info()
                .iter()
                .map(|info| {
                    column(
                        info.name().into(),
                        info.oracle_type().to_string(),
                        info.nullable(),
                    )
                })
                .collect();
            unique_columns(&mut result.columns);
            let mut bytes = 0;
            for (index, row) in rows.enumerate() {
                let row = row.map_err(native_error)?;
                if index < offset {
                    continue;
                }
                if result.rows.len() == limit {
                    break;
                }
                let mut values = Vec::with_capacity(result.columns.len());
                for (index, info) in row.column_info().iter().enumerate() {
                    let value = match info.oracle_type() {
                        OracleType::BLOB => lob(
                            row.get::<_, Option<::oracle::sql_type::Blob>>(index)
                                .map_err(native_error)?,
                            true,
                        )?,
                        OracleType::CLOB => lob(
                            row.get::<_, Option<::oracle::sql_type::Clob>>(index)
                                .map_err(native_error)?,
                            false,
                        )?,
                        OracleType::NCLOB => lob(
                            row.get::<_, Option<::oracle::sql_type::Nclob>>(index)
                                .map_err(native_error)?,
                            false,
                        )?,
                        OracleType::Raw(_) | OracleType::LongRaw => row
                            .get::<_, Option<Vec<u8>>>(index)
                            .map_err(native_error)?
                            .map(|bytes| {
                                Value::String(
                                    base64::engine::general_purpose::STANDARD.encode(bytes),
                                )
                            }),
                        _ => row
                            .get::<_, Option<String>>(index)
                            .map_err(native_error)?
                            .map(Value::String),
                    };
                    values.push(value.unwrap_or(Value::Null));
                }
                append_row(&mut result, values, &mut bytes)?;
            }
        } else {
            result.row_count = self
                .0
                .execute(&request.sql, &parameters)
                .map_err(native_error)?
                .row_count()
                .map_err(native_error)?;
        }
        result.execution_time_ms = start.elapsed().as_millis() as u64;
        Ok(result)
    }
}

fn lob(value: Option<impl Read>, binary: bool) -> Result<Option<Value>, DbError> {
    value
        .map(|value| {
            let mut bytes = Vec::new();
            value
                .take(MAX_CELL_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(native_error)?;
            if bytes.len() > MAX_CELL_BYTES {
                return Err(native_error(
                    "Oracle LOB exceeds 1 MiB; select a bounded projection",
                ));
            }
            Ok(Value::String(if binary {
                base64::engine::general_purpose::STANDARD.encode(bytes)
            } else {
                String::from_utf8(bytes).map_err(native_error)?
            }))
        })
        .transpose()
}
