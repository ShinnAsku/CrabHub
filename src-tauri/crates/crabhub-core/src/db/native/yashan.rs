use super::*;
use base64::Engine;
use yashandb::{input, DataType};

pub(super) struct Client(yashandb::Connection);

impl Client {
    pub(super) fn connect(config: &ConnectionConfig) -> Result<Self, DbError> {
        yashandb::load_library().map_err(|error| DbError::ConfigError(format!("YashanDB native client: {error}; install yascli >= 23.4.1.100 in the native library search path or ~/.yashandb/client/lib")))?;
        let mut connection = yashandb::Connection::connect(
            format!("{}:{}", host(config)?, config.port.unwrap_or(1688)),
            config.username.as_deref().unwrap_or(""),
            config.password.as_deref().unwrap_or(""),
        )
        .map_err(native_error)?;
        connection.set_auto_commit(true);
        if let Some(schema) = config.database.as_deref().filter(|value| !value.is_empty()) {
            connection
                .execute(&format!(
                    "ALTER SESSION SET CURRENT_SCHEMA = \"{}\"",
                    schema.replace('"', "\"\"")
                ))
                .map_err(native_error)?;
        }
        Ok(Self(connection))
    }
}

impl NativeClient for Client {
    fn run(&mut self, request: &Request) -> Result<QueryResult, DbError> {
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
        let mut result = empty_result(start);
        if let Some((limit, offset)) = request.window {
            let mut rows = self
                .0
                .query_with(
                    &request.sql,
                    parameters.into_iter().map(input).collect::<Vec<_>>(),
                )
                .map_err(native_error)?;
            result.columns = rows
                .columns()
                .iter()
                .map(|info| {
                    let mut column = column(
                        info.name().into(),
                        format!("{:?}", info.data_type_info().data_type()),
                        info.nullable(),
                    );
                    if let yashandb::DataTypeInfo::Number { precision, scale } =
                        info.data_type_info()
                    {
                        column.numeric_precision = Some(precision.into());
                        column.numeric_scale = Some(scale.into());
                    }
                    column
                })
                .collect();
            unique_columns(&mut result.columns);
            let mut skipped = 0;
            let mut bytes = 0;
            while result.rows.len() < limit {
                let Some(row) = rows.fetch().map_err(native_error)? else {
                    break;
                };
                if skipped < offset {
                    skipped += 1;
                    continue;
                }
                let values = row
                    .columns()
                    .iter()
                    .enumerate()
                    .map(|(index, info)| cell(&row, index, info.data_type_info().data_type()))
                    .collect::<Result<Vec<_>, _>>()?;
                append_row(&mut result, values, &mut bytes)?;
            }
            rows.finish().map_err(native_error)?;
        } else {
            result.row_count = self
                .0
                .execute_with(
                    &request.sql,
                    parameters.into_iter().map(input).collect::<Vec<_>>(),
                )
                .map_err(native_error)?
                .rows_affected();
        }
        result.execution_time_ms = start.elapsed().as_millis() as u64;
        Ok(result)
    }
}

fn cell(row: &yashandb::Row<'_, '_>, index: usize, kind: DataType) -> Result<Value, DbError> {
    macro_rules! text {
        ($kind:ty) => {
            row.get::<Option<$kind>>(index)
                .map_err(native_error)?
                .map(|value| Value::String(value.to_string()))
                .unwrap_or(Value::Null)
        };
    }
    macro_rules! temporal {
        ($kind:ty, $format:literal) => {
            row.get::<Option<$kind>>(index)
                .map_err(native_error)?
                .map(|value| {
                    value
                        .format($format)
                        .map(|formatted| Value::String(formatted.to_string()))
                        .map_err(native_error)
                })
                .transpose()?
                .unwrap_or(Value::Null)
        };
    }
    Ok(match kind {
        DataType::Bool => row.get::<Option<bool>>(index).map_err(native_error)?.map(Value::Bool).unwrap_or(Value::Null),
        DataType::TinyInt => text!(i8),
        DataType::SmallInt => text!(i16),
        DataType::Integer => text!(i32),
        DataType::BigInt => text!(i64),
        DataType::Float => text!(f32),
        DataType::Double => text!(f64),
        DataType::Number => text!(yashandb::Number),
        DataType::Date => temporal!(yashandb::Date, "YYYY-MM-DD HH24:MI:SS"),
        DataType::Time => temporal!(yashandb::Time, "HH24:MI:SS.FF6"),
        DataType::Timestamp => temporal!(yashandb::Timestamp, "YYYY-MM-DD HH24:MI:SS.FF6"),
        DataType::IntervalYM => temporal!(yashandb::IntervalYM, "YYYY-MM"),
        DataType::IntervalDS => temporal!(yashandb::IntervalDS, "DD HH24:MI:SS.FF6"),
        DataType::Char | DataType::NChar | DataType::VarChar | DataType::NVarChar => text!(String),
        DataType::Binary => row.get::<Option<Vec<u8>>>(index).map_err(native_error)?.map(|value| Value::String(base64::engine::general_purpose::STANDARD.encode(value))).unwrap_or(Value::Null),
        DataType::Json => {
            match row.get::<Option<&yashandb::Yason>>(index).map_err(native_error)? {
                Some(value) => Value::String(json_text(value)?),
                None => Value::Null,
            }
        }
        DataType::Blob => {
            if let Some(lob) = row.get::<Option<yashandb::Blob>>(index).map_err(native_error)? {
                if lob.len().map_err(native_error)? > MAX_CELL_BYTES as u64 { return Err(native_error("BLOB exceeds 1 MiB")); }
                let mut bytes = vec![];
                lob.read_to_end(&mut bytes).map_err(native_error)?;
                Value::String(base64::engine::general_purpose::STANDARD.encode(bytes))
            } else { Value::Null }
        }
        DataType::Clob | DataType::Nclob => {
            if let Some(lob) = row.get::<Option<yashandb::Clob>>(index).map_err(native_error)? {
                let length = lob.len().map_err(native_error)?;
                if length > MAX_CELL_BYTES as u64 { return Err(native_error("CLOB exceeds 1 MiB")); }
                let mut text = String::new();
                let mut offset = 1;
                while offset <= length {
                    let read = lob.read_at(offset, (length - offset + 1).min(4096), &mut text).map_err(native_error)?;
                    if read == 0 { return Err(native_error("CLOB ended before its reported length")); }
                    if text.len() > MAX_CELL_BYTES { return Err(native_error("CLOB exceeds 1 MiB")); }
                    offset += read;
                }
                Value::String(text)
            } else { Value::Null }
        }
        kind => return Err(native_error(format!("YashanDB native driver cannot materialize {kind:?}; cast this column to VARCHAR in the query"))),
    })
}

fn json_text(value: &yashandb::Yason) -> Result<String, DbError> {
    struct BoundedText(String);
    impl std::fmt::Write for BoundedText {
        fn write_str(&mut self, text: &str) -> std::fmt::Result {
            if self.0.len().saturating_add(text.len()) > MAX_CELL_BYTES {
                return Err(std::fmt::Error);
            }
            self.0.push_str(text);
            Ok(())
        }
    }
    let mut output = BoundedText(String::new());
    value
        .format_to(false, false, &mut output)
        .map_err(|error| {
            native_error(format!(
                "Yashan JSON formatting failed or exceeds 1 MiB: {error}"
            ))
        })?;
    Ok(output.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_keeps_strings_null_and_exact_numbers() {
        let value = yashandb::YasonBuf::parse(
            r#"{"label":"00123","missing":null,"amount":12345678901234567890.12345678}"#,
            false,
        )
        .unwrap();
        let text = json_text(&value).unwrap();
        assert!(text.contains("\"00123\""));
        assert!(text.contains("null"));
        assert!(text.contains("12345678901234567890.12345678"));
    }

    #[test]
    fn json_output_limit_is_checked_during_formatting() {
        let input = serde_json::to_string(&"x".repeat(MAX_CELL_BYTES)).unwrap();
        let value = yashandb::YasonBuf::parse(input, false).unwrap();
        assert!(json_text(&value).is_err());
    }
}
