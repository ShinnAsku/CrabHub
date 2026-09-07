use super::*;
use base64::Engine;
use dameng_types::{DmValue, DmValueType, ToDmValue};

pub(super) struct Client {
    connection: Option<tokio_dameng::Client>,
    runtime: tokio::runtime::Runtime,
    timeout: u64,
}

impl Client {
    pub(super) fn connect(config: &ConnectionConfig) -> Result<Self, DbError> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(native_error)?;
        let mut options = tokio_dameng::config::ConnectOptions::new(
            host(config)?.trim_matches(['[', ']']),
            config.port.unwrap_or(5236),
            config.username.as_deref().unwrap_or(""),
            config.password.as_deref().unwrap_or(""),
        )
        .connect_timeout(Duration::from_secs(15))
        .auto_commit(true)
        .max_row_size(MAX_CELL_BYTES as i32);
        if let Some(schema) = config.database.as_deref().filter(|value| !value.is_empty()) {
            options = options.schema(schema);
        }
        let connection = runtime
            .block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(25),
                    tokio_dameng::Client::connect_with(&options),
                )
                .await
            })
            .map_err(native_error)?
            .map_err(native_error)?;
        Ok(Self {
            connection: Some(connection),
            runtime,
            timeout: config.query_timeout_secs,
        })
    }
}

impl NativeClient for Client {
    fn run(&mut self, request: &Request) -> Result<QueryResult, DbError> {
        let mut connection = self
            .connection
            .take()
            .ok_or_else(|| native_error("Dameng session is isolated; reconnect explicitly"))?;
        let result = self.runtime.block_on(async {
            if self.timeout == 0 {
                run_query(&mut connection, request).await
            } else {
                tokio::time::timeout(
                    Duration::from_secs(self.timeout),
                    run_query(&mut connection, request),
                )
                .await
                .map_err(|_| {
                    DbError::Timeout(
                        "Dameng request timed out; completion unknown, not retried".into(),
                    )
                })?
            }
        });
        if result.is_ok() {
            self.connection = Some(connection);
        }
        result
    }
}

async fn run_query(
    connection: &mut tokio_dameng::Client,
    request: &Request,
) -> Result<QueryResult, DbError> {
    let start = Instant::now();
    let parameters: Vec<Option<String>> = request
        .params
        .iter()
        .map(|value| match value {
            Value::Null => None,
            Value::String(value) => Some(value.clone()),
            Value::Bool(value) => Some(if *value { "1" } else { "0" }.into()),
            value => Some(value.to_string()),
        })
        .collect();
    let parameters: Vec<&dyn ToDmValue> = parameters
        .iter()
        .map(|value| value as &dyn ToDmValue)
        .collect();
    let mut result = empty_result(start);
    if let Some((limit, offset)) = request.window {
        let mut rows = connection
            .query_with_params(&request.sql, &parameters)
            .await
            .map_err(native_error)?;
        result.columns = rows
            .columns
            .iter()
            .map(|info| {
                let mut column = column(info.name.clone(), info.type_name.clone(), info.nullable);
                column.numeric_precision = Some(info.precision.into());
                column.numeric_scale = Some(info.scale.into());
                column
            })
            .collect();
        unique_columns(&mut result.columns);
        let mut position = 0;
        let mut bytes = 0;
        loop {
            let batch = std::mem::take(&mut rows.rows);
            if batch.is_empty() {
                break;
            }
            for row in batch {
                let current = position;
                position += 1;
                if current < offset {
                    continue;
                }
                let values = row
                    .values
                    .iter()
                    .zip(&rows.columns)
                    .map(|(value, info)| match value {
                        None => Ok(Value::Null),
                        Some(raw) => decode(raw, info.type_code, info.lob_tab_id, info.lob_col_id),
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                append_row(&mut result, values, &mut bytes)?;
                if result.rows.len() == limit {
                    break;
                }
            }
            if result.rows.len() == limit || position as u64 >= rows.total_row_count {
                break;
            }
            connection
                .fetch_more(&mut rows, position, 32768)
                .await
                .map_err(native_error)?;
            if rows.rows.is_empty() && (position as u64) < rows.total_row_count {
                return Err(native_error(
                    "Dameng cursor ended before its reported row count",
                ));
            }
        }
    } else {
        result.row_count = connection
            .execute_with_params(&request.sql, &parameters)
            .await
            .map_err(native_error)?;
    }
    result.execution_time_ms = start.elapsed().as_millis() as u64;
    Ok(result)
}

fn decode(raw: &[u8], code: i32, table: i32, column: i16) -> Result<Value, DbError> {
    let kind = DmValueType::from_type_code(code)
        .ok_or_else(|| native_error(format!("Unknown Dameng type {code}")))?;
    if matches!(
        kind,
        DmValueType::VARCHAR
            | DmValueType::CHAR
            | DmValueType::VARCHAR2
            | DmValueType::DECIMAL
            | DmValueType::NUMERIC
    ) {
        let text = std::str::from_utf8(raw).map_err(native_error)?;
        if matches!(kind, DmValueType::DECIMAL | DmValueType::NUMERIC)
            && (text.is_empty()
                || !text
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || b"+-.eE".contains(&byte)))
        {
            return Err(native_error("Dameng decimal is not in the driver's supported text format; CAST to VARCHAR to preserve precision"));
        }
        return Ok(Value::String(text.into()));
    }
    if raw.is_empty()
        && matches!(
            kind,
            DmValueType::BINARY | DmValueType::VARBINARY | DmValueType::RAW
        )
    {
        return Ok(Value::String(String::new()));
    }
    let value = dameng_types::decode_value(kind, raw, Some((table, column)))
        .ok_or_else(|| native_error(format!("Cannot decode Dameng {kind:?}")))?;
    Ok(match value {
        DmValue::Null => return Err(native_error("Unexpected empty Dameng typed value")),
        DmValue::Boolean(value) => Value::Bool(value),
        DmValue::TinyInt(value) => Value::String(value.to_string()),
        DmValue::SmallInt(value) => Value::String(value.to_string()),
        DmValue::Int(value) => Value::String(value.to_string()),
        DmValue::BigInt(value) => Value::String(value.to_string()),
        DmValue::Float(value) => Value::String(value.to_string()),
        DmValue::Double(value) => Value::String(value.to_string()),
        DmValue::Decimal(value) => Value::String(value.to_string()),
        DmValue::Text(value) => {
            if !matches!(kind, DmValueType::CLOB) && value.chars().any(char::is_control) { return Err(native_error("Dameng temporal value cannot be decoded safely; CAST to VARCHAR")); }
            Value::String(value)
        }
        DmValue::Bytea(value) => Value::String(base64::engine::general_purpose::STANDARD.encode(value)),
        DmValue::LobLocator(_) => return Err(native_error("Dameng out-of-row LOB requires an explicit bounded SQL projection; native locator materialization is not supported")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_strings_and_binary_are_not_null() {
        assert_eq!(decode(b"", 3, 0, 0).unwrap(), Value::String(String::new()));
        assert_eq!(decode(b"", 17, 0, 0).unwrap(), Value::String(String::new()));
        assert_eq!(
            decode(b"00123", 3, 0, 0).unwrap(),
            Value::String("00123".into())
        );
    }

    #[test]
    fn decimals_do_not_round_through_float_or_rust_decimal() {
        let exact = "123456789012345678901234567890.12345678";
        assert_eq!(
            decode(exact.as_bytes(), 9, 0, 0).unwrap(),
            Value::String(exact.into())
        );
        assert!(decode(&[0xff, 0xfe], 9, 0, 0).is_err());
    }

    #[test]
    fn unsupported_types_do_not_silently_become_null() {
        assert!(decode(b"value", 999, 0, 0).is_err());
        assert!(decode(b"", 4, 0, 0).is_err());
    }
}
