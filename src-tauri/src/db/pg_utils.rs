use rust_decimal::Decimal;
use sqlx::{Column, Row, TypeInfo};

use super::types::ColumnInfo;

// ============================================================================
// Shared parsing utilities for PostgreSQL wire-protocol databases
// ============================================================================

/// Best-effort server-side cancel for PG-protocol databases.
///
/// Opens a short-lived admin connection and cancels every active backend
/// tagged with `app_name` (excluding the admin connection itself). Errors are
/// logged and swallowed — cancel must never fail the caller.
///
/// Returns `true` if the cancel statement was sent successfully.
pub async fn cancel_by_application_name(connection_string: &str, app_name: &str) -> bool {
    use sqlx::Connection;
    let mut admin = match sqlx::postgres::PgConnection::connect(connection_string).await {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[cancel] failed to open admin connection: {}", e);
            return false;
        }
    };
    let result = sqlx::query(
        "SELECT pg_cancel_backend(pid) FROM pg_stat_activity \
         WHERE application_name = $1 AND state = 'active' AND pid <> pg_backend_pid()",
    )
    .bind(app_name)
    .fetch_all(&mut admin)
    .await;
    match result {
        Ok(rows) => {
            log::info!("[cancel] pg_cancel_backend sent to {} session(s) tagged '{}'", rows.len(), app_name);
            true
        }
        Err(e) => {
            log::warn!("[cancel] pg_cancel_backend failed for '{}': {}", app_name, e);
            false
        }
    }
}

/// Build column info from a PgRow by inspecting column descriptions
pub fn build_columns_from_pg_row(row: &sqlx::postgres::PgRow) -> Vec<ColumnInfo> {
    let columns = row.columns();
    let mut result = Vec::with_capacity(columns.len());
    for col in columns {
        result.push(ColumnInfo {
            name: col.name().to_string(),
            data_type: format!("{:?}", col.type_info()),
            nullable: true,
            is_primary_key: false,
            default_value: None,
            comment: None,
            character_maximum_length: None,
            numeric_precision: None,
            numeric_scale: None,
        });
    }
    result
}

/// Format a PgInterval into a human-readable string
pub fn format_pg_interval(interval: &sqlx::postgres::types::PgInterval) -> String {
    let mut parts = Vec::new();
    if interval.months != 0 {
        let years = interval.months / 12;
        let months = interval.months % 12;
        if years != 0 {
            parts.push(format!(
                "{} year{}",
                years,
                if years.abs() != 1 { "s" } else { "" }
            ));
        }
        if months != 0 {
            parts.push(format!(
                "{} mon{}",
                months,
                if months.abs() != 1 { "s" } else { "" }
            ));
        }
    }
    if interval.days != 0 {
        parts.push(format!(
            "{} day{}",
            interval.days,
            if interval.days.abs() != 1 { "s" } else { "" }
        ));
    }
    if interval.microseconds != 0 {
        let total_secs = interval.microseconds / 1_000_000;
        let hours = total_secs / 3600;
        let mins = (total_secs % 3600) / 60;
        let secs = total_secs % 60;
        let micros = interval.microseconds % 1_000_000;
        if micros != 0 {
            parts.push(format!(
                "{:02}:{:02}:{:02}.{:06}",
                hours, mins, secs, micros
            ));
        } else {
            parts.push(format!("{:02}:{:02}:{:02}", hours, mins, secs));
        }
    }
    if parts.is_empty() {
        "00:00:00".to_string()
    } else {
        parts.join(" ")
    }
}

/// Parse a slice of PgRows into column info and row maps.
/// Handles the full type-matching dispatch for PostgreSQL binary protocol results.
pub fn parse_pg_rows(
    rows: &[sqlx::postgres::PgRow],
) -> (Vec<ColumnInfo>, Vec<serde_json::Map<String, serde_json::Value>>) {
    if rows.is_empty() {
        return (vec![], vec![]);
    }

    let columns = build_columns_from_pg_row(&rows[0]);

    let mut result_rows = Vec::with_capacity(rows.len());
    for row in rows {
        let mut map = serde_json::Map::new();
        for col in row.columns() {
            let name = col.name().to_string();
            let type_name = col.type_info().name();
            let value = match type_name {
                "BOOL" => {
                    if let Ok(Some(v)) = row.try_get::<Option<bool>, _>(col.name()) {
                        serde_json::Value::Bool(v)
                    } else if let Ok(v) = row.try_get::<bool, _>(col.name()) {
                        serde_json::Value::Bool(v)
                    } else {
                        serde_json::Value::Null
                    }
                }
                "INT2" => {
                    if let Ok(Some(v)) = row.try_get::<Option<i16>, _>(col.name()) {
                        serde_json::json!(v)
                    } else if let Ok(v) = row.try_get::<i16, _>(col.name()) {
                        serde_json::json!(v)
                    } else {
                        serde_json::Value::Null
                    }
                }
                "INT4" | "OID" => {
                    if let Ok(Some(v)) = row.try_get::<Option<i32>, _>(col.name()) {
                        serde_json::json!(v)
                    } else if let Ok(v) = row.try_get::<i32, _>(col.name()) {
                        serde_json::json!(v)
                    } else {
                        serde_json::Value::Null
                    }
                }
                "INT8" => {
                    if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(col.name()) {
                        serde_json::json!(v)
                    } else if let Ok(v) = row.try_get::<i64, _>(col.name()) {
                        serde_json::json!(v)
                    } else {
                        serde_json::Value::Null
                    }
                }
                "FLOAT4" => {
                    if let Ok(Some(v)) = row.try_get::<Option<f32>, _>(col.name()) {
                        serde_json::json!(v)
                    } else if let Ok(v) = row.try_get::<f32, _>(col.name()) {
                        serde_json::json!(v)
                    } else {
                        serde_json::Value::Null
                    }
                }
                "FLOAT8" => {
                    if let Ok(Some(v)) = row.try_get::<Option<f64>, _>(col.name()) {
                        serde_json::json!(v)
                    } else if let Ok(v) = row.try_get::<f64, _>(col.name()) {
                        serde_json::json!(v)
                    } else {
                        serde_json::Value::Null
                    }
                }
                "NUMERIC" | "MONEY" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Decimal>, _>(col.name()) {
                        serde_json::json!(v)
                    } else if let Ok(v) = row.try_get::<Decimal, _>(col.name()) {
                        serde_json::json!(v)
                    } else if let Ok(Some(v)) = row.try_get::<Option<i64>, _>(col.name()) {
                        serde_json::json!(v)
                    } else if let Ok(v) = row.try_get::<i64, _>(col.name()) {
                        serde_json::json!(v)
                    } else {
                        serde_json::Value::Null
                    }
                }
                "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" | "XML" => {
                    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                        serde_json::Value::String(v)
                    } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                        serde_json::Value::String(v)
                    } else {
                        serde_json::Value::Null
                    }
                }
                "UUID" => {
                    if let Ok(Some(v)) = row.try_get::<Option<uuid::Uuid>, _>(col.name()) {
                        serde_json::Value::String(v.to_string())
                    } else if let Ok(v) = row.try_get::<uuid::Uuid, _>(col.name()) {
                        serde_json::Value::String(v.to_string())
                    } else {
                        serde_json::Value::Null
                    }
                }
                "DATE" => {
                    if let Ok(Some(v)) =
                        row.try_get::<Option<chrono::NaiveDate>, _>(col.name())
                    {
                        serde_json::Value::String(v.to_string())
                    } else if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(col.name()) {
                        serde_json::Value::String(v.to_string())
                    } else {
                        serde_json::Value::Null
                    }
                }
                "TIME" => {
                    if let Ok(Some(v)) =
                        row.try_get::<Option<chrono::NaiveTime>, _>(col.name())
                    {
                        serde_json::Value::String(v.to_string())
                    } else if let Ok(v) = row.try_get::<chrono::NaiveTime, _>(col.name()) {
                        serde_json::Value::String(v.to_string())
                    } else {
                        serde_json::Value::Null
                    }
                }
                "TIMETZ" => {
                    if let Ok(Some(v)) =
                        row.try_get::<Option<sqlx::postgres::types::PgTimeTz>, _>(col.name())
                    {
                        serde_json::Value::String(format!("{}{}", v.time, v.offset))
                    } else if let Ok(v) =
                        row.try_get::<sqlx::postgres::types::PgTimeTz, _>(col.name())
                    {
                        serde_json::Value::String(format!("{}{}", v.time, v.offset))
                    } else {
                        serde_json::Value::Null
                    }
                }
                "TIMESTAMP" => {
                    if let Ok(Some(v)) =
                        row.try_get::<Option<chrono::NaiveDateTime>, _>(col.name())
                    {
                        serde_json::Value::String(
                            v.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
                        )
                    } else if let Ok(v) =
                        row.try_get::<chrono::NaiveDateTime, _>(col.name())
                    {
                        serde_json::Value::String(
                            v.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
                        )
                    } else {
                        serde_json::Value::Null
                    }
                }
                "TIMESTAMPTZ" => {
                    if let Ok(Some(v)) =
                        row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(col.name())
                    {
                        serde_json::Value::String(
                            v.format("%Y-%m-%d %H:%M:%S%.f%z").to_string(),
                        )
                    } else if let Ok(v) =
                        row.try_get::<chrono::DateTime<chrono::Utc>, _>(col.name())
                    {
                        serde_json::Value::String(
                            v.format("%Y-%m-%d %H:%M:%S%.f%z").to_string(),
                        )
                    } else {
                        serde_json::Value::Null
                    }
                }
                "INTERVAL" => {
                    if let Ok(Some(v)) =
                        row.try_get::<Option<sqlx::postgres::types::PgInterval>, _>(col.name())
                    {
                        serde_json::Value::String(format_pg_interval(&v))
                    } else if let Ok(v) =
                        row.try_get::<sqlx::postgres::types::PgInterval, _>(col.name())
                    {
                        serde_json::Value::String(format_pg_interval(&v))
                    } else {
                        serde_json::Value::Null
                    }
                }
                "JSON" | "JSONB" => {
                    if let Ok(Some(v)) =
                        row.try_get::<Option<sqlx::types::Json<serde_json::Value>>, _>(
                            col.name(),
                        )
                    {
                        v.0
                    } else if let Ok(v) =
                        row.try_get::<sqlx::types::Json<serde_json::Value>, _>(col.name())
                    {
                        v.0
                    } else {
                        serde_json::Value::Null
                    }
                }
                "BYTEA" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                        let hex_str: String =
                            v.iter().map(|b| format!("{:02x}", b)).collect();
                        serde_json::Value::String(format!("\\x{}", hex_str))
                    } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                        let hex_str: String =
                            v.iter().map(|b| format!("{:02x}", b)).collect();
                        serde_json::Value::String(format!("\\x{}", hex_str))
                    } else {
                        serde_json::Value::Null
                    }
                }
                "INET" | "CIDR" => {
                    if let Ok(Some(v)) =
                        row.try_get::<Option<ipnetwork::IpNetwork>, _>(col.name())
                    {
                        serde_json::Value::String(v.to_string())
                    } else if let Ok(v) =
                        row.try_get::<ipnetwork::IpNetwork, _>(col.name())
                    {
                        serde_json::Value::String(v.to_string())
                    } else {
                        serde_json::Value::Null
                    }
                }
                "MACADDR" | "MACADDR8" => {
                    if let Ok(Some(v)) =
                        row.try_get::<Option<mac_address::MacAddress>, _>(col.name())
                    {
                        serde_json::Value::String(v.to_string())
                    } else if let Ok(v) =
                        row.try_get::<mac_address::MacAddress, _>(col.name())
                    {
                        serde_json::Value::String(v.to_string())
                    } else {
                        serde_json::Value::Null
                    }
                }
                "POINT" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                        if v.len() == 16 {
                            let x = f64::from_be_bytes(
                                v[0..8].try_into().unwrap_or([0u8; 8]),
                            );
                            let y = f64::from_be_bytes(
                                v[8..16].try_into().unwrap_or([0u8; 8]),
                            );
                            serde_json::Value::String(format!("({},{})", x, y))
                        } else {
                            serde_json::Value::Null
                        }
                    } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                        if v.len() == 16 {
                            let x = f64::from_be_bytes(
                                v[0..8].try_into().unwrap_or([0u8; 8]),
                            );
                            let y = f64::from_be_bytes(
                                v[8..16].try_into().unwrap_or([0u8; 8]),
                            );
                            serde_json::Value::String(format!("({},{})", x, y))
                        } else {
                            serde_json::Value::Null
                        }
                    } else {
                        serde_json::Value::Null
                    }
                }
                "CIRCLE" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                        if v.len() == 24 {
                            let cx = f64::from_be_bytes(
                                v[0..8].try_into().unwrap_or([0u8; 8]),
                            );
                            let cy = f64::from_be_bytes(
                                v[8..16].try_into().unwrap_or([0u8; 8]),
                            );
                            let r = f64::from_be_bytes(
                                v[16..24].try_into().unwrap_or([0u8; 8]),
                            );
                            serde_json::Value::String(format!("<({},{}),{}>", cx, cy, r))
                        } else {
                            serde_json::Value::Null
                        }
                    } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                        if v.len() == 24 {
                            let cx = f64::from_be_bytes(
                                v[0..8].try_into().unwrap_or([0u8; 8]),
                            );
                            let cy = f64::from_be_bytes(
                                v[8..16].try_into().unwrap_or([0u8; 8]),
                            );
                            let r = f64::from_be_bytes(
                                v[16..24].try_into().unwrap_or([0u8; 8]),
                            );
                            serde_json::Value::String(format!("<({},{}),{}>", cx, cy, r))
                        } else {
                            serde_json::Value::Null
                        }
                    } else {
                        serde_json::Value::Null
                    }
                }
                "LINE" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                        if v.len() == 24 {
                            let a = f64::from_be_bytes(
                                v[0..8].try_into().unwrap_or([0u8; 8]),
                            );
                            let b = f64::from_be_bytes(
                                v[8..16].try_into().unwrap_or([0u8; 8]),
                            );
                            let c = f64::from_be_bytes(
                                v[16..24].try_into().unwrap_or([0u8; 8]),
                            );
                            serde_json::Value::String(format!("{{{},{},{}}}", a, b, c))
                        } else {
                            serde_json::Value::Null
                        }
                    } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                        if v.len() == 24 {
                            let a = f64::from_be_bytes(
                                v[0..8].try_into().unwrap_or([0u8; 8]),
                            );
                            let b = f64::from_be_bytes(
                                v[8..16].try_into().unwrap_or([0u8; 8]),
                            );
                            let c = f64::from_be_bytes(
                                v[16..24].try_into().unwrap_or([0u8; 8]),
                            );
                            serde_json::Value::String(format!("{{{},{},{}}}", a, b, c))
                        } else {
                            serde_json::Value::Null
                        }
                    } else {
                        serde_json::Value::Null
                    }
                }
                "LSEG" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                        if v.len() == 32 {
                            let x1 = f64::from_be_bytes(
                                v[0..8].try_into().unwrap_or([0u8; 8]),
                            );
                            let y1 = f64::from_be_bytes(
                                v[8..16].try_into().unwrap_or([0u8; 8]),
                            );
                            let x2 = f64::from_be_bytes(
                                v[16..24].try_into().unwrap_or([0u8; 8]),
                            );
                            let y2 = f64::from_be_bytes(
                                v[24..32].try_into().unwrap_or([0u8; 8]),
                            );
                            serde_json::Value::String(format!(
                                "[({},{}),({},{})]",
                                x1, y1, x2, y2
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                        if v.len() == 32 {
                            let x1 = f64::from_be_bytes(
                                v[0..8].try_into().unwrap_or([0u8; 8]),
                            );
                            let y1 = f64::from_be_bytes(
                                v[8..16].try_into().unwrap_or([0u8; 8]),
                            );
                            let x2 = f64::from_be_bytes(
                                v[16..24].try_into().unwrap_or([0u8; 8]),
                            );
                            let y2 = f64::from_be_bytes(
                                v[24..32].try_into().unwrap_or([0u8; 8]),
                            );
                            serde_json::Value::String(format!(
                                "[({},{}),({},{})]",
                                x1, y1, x2, y2
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    } else {
                        serde_json::Value::Null
                    }
                }
                "BOX" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                        if v.len() == 32 {
                            let x1 = f64::from_be_bytes(
                                v[0..8].try_into().unwrap_or([0u8; 8]),
                            );
                            let y1 = f64::from_be_bytes(
                                v[8..16].try_into().unwrap_or([0u8; 8]),
                            );
                            let x2 = f64::from_be_bytes(
                                v[16..24].try_into().unwrap_or([0u8; 8]),
                            );
                            let y2 = f64::from_be_bytes(
                                v[24..32].try_into().unwrap_or([0u8; 8]),
                            );
                            serde_json::Value::String(format!(
                                "(({},{}),({},{}))",
                                x1, y1, x2, y2
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                        if v.len() == 32 {
                            let x1 = f64::from_be_bytes(
                                v[0..8].try_into().unwrap_or([0u8; 8]),
                            );
                            let y1 = f64::from_be_bytes(
                                v[8..16].try_into().unwrap_or([0u8; 8]),
                            );
                            let x2 = f64::from_be_bytes(
                                v[16..24].try_into().unwrap_or([0u8; 8]),
                            );
                            let y2 = f64::from_be_bytes(
                                v[24..32].try_into().unwrap_or([0u8; 8]),
                            );
                            serde_json::Value::String(format!(
                                "(({},{}),({},{}))",
                                x1, y1, x2, y2
                            ))
                        } else {
                            serde_json::Value::Null
                        }
                    } else {
                        serde_json::Value::Null
                    }
                }
                "PATH" | "POLYGON" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name()) {
                        let hex_str: String =
                            v.iter().map(|b| format!("{:02x}", b)).collect();
                        serde_json::Value::String(hex_str)
                    } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                        let hex_str: String =
                            v.iter().map(|b| format!("{:02x}", b)).collect();
                        serde_json::Value::String(hex_str)
                    } else {
                        serde_json::Value::Null
                    }
                }
                // Array types
                "BOOL[]" | "_BOOL" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<bool>>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|b| b.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else if let Ok(v) = row.try_get::<Vec<bool>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|b| b.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else {
                        serde_json::Value::Null
                    }
                }
                "INT2[]" | "_INT2" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<i16>>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|i| i.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else if let Ok(v) = row.try_get::<Vec<i16>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|i| i.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else {
                        serde_json::Value::Null
                    }
                }
                "INT4[]" | "_INT4" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<i32>>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|i| i.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else if let Ok(v) = row.try_get::<Vec<i32>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|i| i.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else {
                        serde_json::Value::Null
                    }
                }
                "INT8[]" | "_INT8" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<i64>>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|i| i.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else if let Ok(v) = row.try_get::<Vec<i64>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|i| i.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else {
                        serde_json::Value::Null
                    }
                }
                "FLOAT4[]" | "_FLOAT4" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<f32>>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|f| f.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else if let Ok(v) = row.try_get::<Vec<f32>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|f| f.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else {
                        serde_json::Value::Null
                    }
                }
                "FLOAT8[]" | "_FLOAT8" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<f64>>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|f| f.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else if let Ok(v) = row.try_get::<Vec<f64>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|f| f.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else {
                        serde_json::Value::Null
                    }
                }
                "TEXT[]" | "_TEXT" | "VARCHAR[]" | "_VARCHAR" => {
                    if let Ok(Some(v)) = row.try_get::<Option<Vec<String>>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|s| format!("\"{}\"", s))
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else if let Ok(v) = row.try_get::<Vec<String>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|s| format!("\"{}\"", s))
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else {
                        serde_json::Value::Null
                    }
                }
                "UUID[]" | "_UUID" => {
                    if let Ok(Some(v)) =
                        row.try_get::<Option<Vec<uuid::Uuid>>, _>(col.name())
                    {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|u| u.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else if let Ok(v) = row.try_get::<Vec<uuid::Uuid>, _>(col.name()) {
                        serde_json::Value::String(format!(
                            "{{{}}}",
                            v.iter()
                                .map(|u| u.to_string())
                                .collect::<Vec<_>>()
                                .join(",")
                        ))
                    } else {
                        serde_json::Value::Null
                    }
                }
                _ => {
                    // Try string first (covers most remaining types)
                    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(col.name()) {
                        serde_json::Value::String(v)
                    } else if let Ok(v) = row.try_get::<String, _>(col.name()) {
                        serde_json::Value::String(v)
                    } else if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(col.name())
                    {
                        serde_json::Value::String(
                            String::from_utf8_lossy(&v).to_string(),
                        )
                    } else if let Ok(v) = row.try_get::<Vec<u8>, _>(col.name()) {
                        serde_json::Value::String(
                            String::from_utf8_lossy(&v).to_string(),
                        )
                    } else {
                        serde_json::Value::Null
                    }
                }
            };
            map.insert(name, value);
        }
        result_rows.push(map);
    }

    (columns, result_rows)
}

/// Build a full table reference (schema.table or just table)
pub fn full_table(table: &str, schema: Option<&str>) -> String {
    match schema {
        Some(s) if !s.is_empty() => format!("{}.{}", s, table),
        _ => table.to_string(),
    }
}

/// Build a quoted full table reference ("schema"."table" or "table")
pub fn full_table_quoted(table: &str, schema: Option<&str>) -> String {
    let tbl = format!("\"{}\"", table.replace('"', "\"\""));
    match schema {
        Some(s) if !s.is_empty() => format!("\"{}\".{}", s.replace('"', "\"\""), tbl),
        _ => tbl,
    }
}
