use super::*;
use base64::Engine;
use odbc_api::buffers::Indicator;
use odbc_api::parameter::{InputParameter, VarBinaryBox, VarWCharBox};
use odbc_api::{ConnectionOptions, Cursor, IntoParameter};

pub(super) struct Client {
    connection: odbc_api::Connection<'static>,
    timeout: usize,
}

impl Client {
    pub(super) fn connect(config: &ConnectionConfig) -> Result<Self, DbError> {
        let driver = std::env::var("CRABHUB_GBASE_ODBC_DRIVER").map_err(|_| DbError::ConfigError("Install the GBase 8s ODBC driver matching this application's architecture and set CRABHUB_GBASE_ODBC_DRIVER to its registered driver name".into()))?;
        let database = config
            .database
            .as_deref()
            .filter(|value| !value.is_empty())
            .ok_or_else(|| DbError::ConfigError("GBase 8s database is required".into()))?;
        let hostname = host(config)?;
        let port = config.port.unwrap_or(5258).to_string();
        let mut attributes = vec![
            ("DRIVER", driver.as_str()),
            ("HOST", hostname.as_str()),
            ("SERVICE", port.as_str()),
            ("PROTOCOL", "onsoctcp"),
            ("DATABASE", database),
            ("UID", config.username.as_deref().unwrap_or("")),
            ("PWD", config.password.as_deref().unwrap_or("")),
            ("DELIMIDENT", "y"),
        ];
        let server = std::env::var("CRABHUB_GBASE_SERVER").ok();
        if let Some(server) = &server {
            attributes.push(("SERVER", server));
        }
        let client_locale = std::env::var("CRABHUB_GBASE_CLIENT_LOCALE").ok();
        if let Some(locale) = &client_locale {
            attributes.push(("CLIENT_LOCALE", locale));
        }
        let db_locale = std::env::var("CRABHUB_GBASE_DB_LOCALE").ok();
        if let Some(locale) = &db_locale {
            attributes.push(("DB_LOCALE", locale));
        }
        if attributes.iter().any(|(_, value)| value.contains('\0')) {
            return Err(DbError::ConfigError(
                "NUL is not allowed in ODBC attributes".into(),
            ));
        }
        let connection_string = attributes
            .into_iter()
            .map(|(key, value)| format!("{key}={};", odbc_api::escape_attribute_value(value)))
            .collect::<String>();
        let environment = odbc_api::environment().map_err(native_error)?;
        let connection = environment
            .connect_with_connection_string(
                &connection_string,
                ConnectionOptions {
                    login_timeout_sec: Some(15),
                    ..Default::default()
                },
            )
            .map_err(native_error)?;
        connection.set_autocommit(true).map_err(native_error)?;
        Ok(Self {
            connection,
            timeout: usize::try_from(config.query_timeout_secs).map_err(native_error)?,
        })
    }
}

impl NativeClient for Client {
    fn run(&mut self, request: &Request) -> Result<QueryResult, DbError> {
        let start = Instant::now();
        let mut statement = self.connection.preallocate().map_err(native_error)?;
        statement
            .set_query_timeout_sec(self.timeout)
            .map_err(native_error)?;
        if let Some(catalog) = &request.catalog {
            let cursor = match catalog {
                Catalog::Tables { schema, views } => statement.tables_cursor(
                    "",
                    &schema.as_deref().map(pattern).unwrap_or_else(|| "%".into()),
                    "%",
                    if *views { "VIEW" } else { "TABLE" },
                ),
                Catalog::Columns { table, schema } => {
                    statement.columns_cursor("", &pattern(schema), &pattern(table), "%")
                }
                Catalog::PrimaryKeys { table, schema } => {
                    statement.primary_keys_cursor(None, Some(schema), table)
                }
                Catalog::ForeignKeys { table, schema } => {
                    statement.foreign_keys_cursor("", "", "", "", schema, table)
                }
            }
            .map_err(native_error)?;
            return collect(cursor, MAX_ROWS + 1, 0, start);
        }
        let parameters: Vec<Box<dyn InputParameter>> = request
            .params
            .iter()
            .map(|value| {
                let text = match value {
                    Value::Null => {
                        return Box::new(None::<String>.into_parameter()) as Box<dyn InputParameter>
                    }
                    Value::String(value) => value.clone(),
                    Value::Bool(value) => {
                        if *value {
                            "1".into()
                        } else {
                            "0".into()
                        }
                    }
                    value => value.to_string(),
                };
                let mut buffer: Vec<u16> = text.encode_utf16().collect();
                let length = buffer.len() * 2;
                buffer.push(0);
                Box::new(VarWCharBox::from_buffer(
                    buffer.into_boxed_slice(),
                    Indicator::Length(length),
                )) as Box<dyn InputParameter>
            })
            .collect();
        let cursor = statement
            .execute(&request.sql, parameters.as_slice())
            .map_err(native_error)?;
        let mut result = if let Some((limit, offset)) = request.window {
            collect(
                cursor.ok_or_else(|| native_error("Statement did not return a result set"))?,
                limit,
                offset,
                start,
            )?
        } else {
            if cursor.is_some() {
                return Err(native_error(
                    "Statement returned rows; use the query operation",
                ));
            }
            drop(cursor);
            let mut result = empty_result(start);
            result.row_count = statement.row_count().map_err(native_error)?.unwrap_or(0) as u64;
            result
        };
        result.execution_time_ms = start.elapsed().as_millis() as u64;
        Ok(result)
    }
}

fn pattern(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('_', "\\_")
        .replace('%', "\\%")
}

fn collect(
    mut cursor: impl Cursor,
    limit: usize,
    offset: usize,
    start: Instant,
) -> Result<QueryResult, DbError> {
    let count = cursor.num_result_cols().map_err(native_error)? as u16;
    let mut result = empty_result(start);
    let mut binary = Vec::new();
    for index in 1..=count {
        let kind = cursor.col_data_type(index).map_err(native_error)?;
        binary.push(matches!(
            kind,
            odbc_api::DataType::Binary { .. }
                | odbc_api::DataType::Varbinary { .. }
                | odbc_api::DataType::LongVarbinary { .. }
        ));
        result.columns.push(column(
            cursor.col_name(index).map_err(native_error)?,
            format!("{kind:?}"),
            true,
        ));
    }
    unique_columns(&mut result.columns);
    let mut skipped = 0;
    let mut bytes = 0;
    let mut text_buffer = VarWCharBox::from_buffer(
        vec![0u16; MAX_CELL_BYTES / 2 + 1].into_boxed_slice(),
        Indicator::Null,
    );
    let mut binary_buffer = VarBinaryBox::from_buffer(
        vec![0u8; MAX_CELL_BYTES].into_boxed_slice(),
        Indicator::Null,
    );
    while result.rows.len() < limit {
        let Some(mut row) = cursor.next_row().map_err(native_error)? else {
            break;
        };
        if skipped < offset {
            skipped += 1;
            continue;
        }
        let mut values = Vec::new();
        for index in 1..=count {
            let value = if binary[index as usize - 1] {
                row.get_data(index, &mut binary_buffer)
                    .map_err(native_error)?;
                if !binary_buffer.is_complete() {
                    return Err(native_error(
                        "ODBC binary value exceeds 1 MiB; truncation rejected",
                    ));
                }
                binary_buffer
                    .as_slice()
                    .map(|value| {
                        Value::String(base64::engine::general_purpose::STANDARD.encode(value))
                    })
                    .unwrap_or(Value::Null)
            } else {
                row.get_data(index, &mut text_buffer)
                    .map_err(native_error)?;
                if !text_buffer.is_complete() {
                    return Err(native_error(
                        "ODBC text exceeds the cell limit; truncation rejected",
                    ));
                }
                text_buffer
                    .as_slice()
                    .map(|value| {
                        String::from_utf16(value)
                            .map(Value::String)
                            .map_err(native_error)
                    })
                    .transpose()?
                    .unwrap_or(Value::Null)
            };
            values.push(value);
        }
        append_row(&mut result, values, &mut bytes)?;
    }
    result.execution_time_ms = start.elapsed().as_millis() as u64;
    Ok(result)
}
