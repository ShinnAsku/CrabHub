//! Streaming query-result export.
//!
//! Exports run SERVER-SIDE in batches (`query_paged`) and stream straight to
//! disk through a `BufWriter`, so memory stays flat regardless of table size.
//! The frontend's in-memory export path only covers rows already loaded into
//! the grid (capped at MAX_DISPLAY_ROWS); this module has no such limit.
//!
//! Progress is reported via `export-progress` events; exports are cancellable
//! through `cancel_export`.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use super::manager::ConnectionManager;
use super::trait_def::json_value_to_sql;
use super::types::{ColumnInfo, DbError};

/// Rows fetched per round-trip. Large enough to amortize query overhead,
/// small enough to keep memory flat and progress events frequent.
const BATCH_SIZE: u64 = 5000;

/// Export ids cancelled by the user. Checked between batches.
fn cancelled_exports() -> &'static Mutex<HashSet<String>> {
    static CANCELLED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(HashSet::new()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub export_id: String,
    pub rows_written: u64,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub rows_written: u64,
    pub file_path: String,
    pub cancelled: bool,
}

/// Format-specific streaming writer.
enum FormatWriter {
    Csv(BufWriter<File>),
    Json { w: BufWriter<File>, first: bool },
    Sql { w: BufWriter<File>, table: String },
    Xlsx { workbook: Box<rust_xlsxwriter::Workbook>, path: String, row: u32 },
}

fn csv_escape(s: &str) -> String {
    if s.contains(',') || s.contains('"') || s.contains('\n') || s.contains('\r') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

fn cell_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

impl FormatWriter {
    fn new(format: &str, path: &str, table: &str, columns: &[ColumnInfo]) -> Result<Self, DbError> {
        let open = || {
            File::create(path)
                .map(BufWriter::new)
                .map_err(|e| DbError::Internal(format!("Cannot create export file: {}", e)))
        };
        match format {
            "csv" => {
                let mut w = open()?;
                let header: Vec<String> = columns.iter().map(|c| csv_escape(&c.name)).collect();
                writeln!(w, "{}", header.join(","))
                    .map_err(|e| DbError::Internal(e.to_string()))?;
                Ok(FormatWriter::Csv(w))
            }
            "json" => {
                let mut w = open()?;
                w.write_all(b"[")
                    .map_err(|e| DbError::Internal(e.to_string()))?;
                Ok(FormatWriter::Json { w, first: true })
            }
            "sql" => Ok(FormatWriter::Sql { w: open()?, table: table.to_string() }),
            "xlsx" => {
                let mut workbook = rust_xlsxwriter::Workbook::new();
                let sheet = workbook
                    .add_worksheet()
                    .set_name("Export")
                    .map_err(|e| DbError::Internal(e.to_string()))?;
                for (i, c) in columns.iter().enumerate() {
                    sheet
                        .write_string(0, i as u16, &c.name)
                        .map_err(|e| DbError::Internal(e.to_string()))?;
                }
                Ok(FormatWriter::Xlsx { workbook: Box::new(workbook), path: path.to_string(), row: 1 })
            }
            other => Err(DbError::ConfigError(format!("Unsupported export format: {}", other))),
        }
    }

    fn write_batch(
        &mut self,
        columns: &[ColumnInfo],
        rows: &[serde_json::Map<String, serde_json::Value>],
    ) -> Result<(), DbError> {
        let io = |e: std::io::Error| DbError::Internal(format!("Export write failed: {}", e));
        match self {
            FormatWriter::Csv(w) => {
                for row in rows {
                    let line: Vec<String> = columns
                        .iter()
                        .map(|c| csv_escape(&cell_to_string(row.get(&c.name).unwrap_or(&serde_json::Value::Null))))
                        .collect();
                    writeln!(w, "{}", line.join(",")).map_err(io)?;
                }
            }
            FormatWriter::Json { w, first } => {
                for row in rows {
                    if *first {
                        *first = false;
                    } else {
                        w.write_all(b",").map_err(io)?;
                    }
                    w.write_all(b"\n  ").map_err(io)?;
                    // Rebuild the object in column order for stable output
                    let ordered: serde_json::Map<String, serde_json::Value> = columns
                        .iter()
                        .map(|c| {
                            (c.name.clone(), row.get(&c.name).cloned().unwrap_or(serde_json::Value::Null))
                        })
                        .collect();
                    serde_json::to_writer(&mut *w, &ordered)
                        .map_err(|e| DbError::Internal(e.to_string()))?;
                }
            }
            FormatWriter::Sql { w, table } => {
                let col_list: Vec<String> = columns.iter().map(|c| format!("\"{}\"", c.name.replace('"', "\"\""))).collect();
                for row in rows {
                    let values: Vec<String> = columns
                        .iter()
                        .map(|c| json_value_to_sql(row.get(&c.name).unwrap_or(&serde_json::Value::Null)))
                        .collect();
                    writeln!(
                        w,
                        "INSERT INTO \"{}\" ({}) VALUES ({});",
                        table.replace('"', "\"\""),
                        col_list.join(", "),
                        values.join(", ")
                    )
                    .map_err(io)?;
                }
            }
            FormatWriter::Xlsx { workbook, row: next_row, .. } => {
                let sheet = workbook
                    .worksheet_from_index(0)
                    .map_err(|e| DbError::Internal(e.to_string()))?;
                for row in rows {
                    for (i, c) in columns.iter().enumerate() {
                        let v = row.get(&c.name).unwrap_or(&serde_json::Value::Null);
                        match v {
                            serde_json::Value::Null => {}
                            serde_json::Value::Number(n) => {
                                if let Some(f) = n.as_f64() {
                                    sheet
                                        .write_number(*next_row, i as u16, f)
                                        .map_err(|e| DbError::Internal(e.to_string()))?;
                                }
                            }
                            serde_json::Value::Bool(b) => {
                                sheet
                                    .write_boolean(*next_row, i as u16, *b)
                                    .map_err(|e| DbError::Internal(e.to_string()))?;
                            }
                            other => {
                                sheet
                                    .write_string(*next_row, i as u16, cell_to_string(other))
                                    .map_err(|e| DbError::Internal(e.to_string()))?;
                            }
                        }
                    }
                    *next_row += 1;
                }
            }
        }
        Ok(())
    }

    fn finish(self) -> Result<(), DbError> {
        let io = |e: std::io::Error| DbError::Internal(format!("Export finalize failed: {}", e));
        match self {
            FormatWriter::Csv(mut w) => w.flush().map_err(io),
            FormatWriter::Json { mut w, first } => {
                if first {
                    w.write_all(b"]").map_err(io)?;
                } else {
                    w.write_all(b"\n]").map_err(io)?;
                }
                w.flush().map_err(io)
            }
            FormatWriter::Sql { mut w, .. } => w.flush().map_err(io),
            FormatWriter::Xlsx { mut workbook, path, .. } => workbook
                .save(&path)
                .map_err(|e| DbError::Internal(format!("XLSX save failed: {}", e))),
        }
    }
}

/// Stream a query's full result set to a file, batch by batch.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // signature mirrors the IPC payload
pub async fn export_query_to_file(
    state: State<'_, Arc<ConnectionManager>>,
    app: AppHandle,
    id: String,
    sql: String,
    format: String,
    file_path: String,
    export_id: String,
    table_name: Option<String>,
) -> Result<ExportSummary, String> {
    cancelled_exports().lock().unwrap().remove(&export_id);

    let table = table_name.unwrap_or_else(|| "export".to_string());
    let mut writer: Option<FormatWriter> = None;
    let mut rows_written: u64 = 0;
    let mut offset: u64 = 0;
    let mut cancelled = false;

    loop {
        if cancelled_exports().lock().unwrap().remove(&export_id) {
            cancelled = true;
            break;
        }

        let page = state
            .query_paged(&id, &sql, BATCH_SIZE, offset)
            .await
            .map_err(|e| e.to_string())?;

        if writer.is_none() {
            writer = Some(
                FormatWriter::new(&format, &file_path, &table, &page.columns)
                    .map_err(|e| e.to_string())?,
            );
        }
        if let Some(w) = writer.as_mut() {
            w.write_batch(&page.columns, &page.rows).map_err(|e| e.to_string())?;
        }

        rows_written += page.rows.len() as u64;
        offset += page.rows.len() as u64;

        let _ = app.emit(
            "export-progress",
            ExportProgress { export_id: export_id.clone(), rows_written, done: false },
        );

        if !page.has_more || page.rows.is_empty() {
            break;
        }
    }

    if let Some(w) = writer {
        w.finish().map_err(|e| e.to_string())?;
    }

    let _ = app.emit(
        "export-progress",
        ExportProgress { export_id: export_id.clone(), rows_written, done: true },
    );

    log::info!(
        "[export] id={} format={} rows={} cancelled={} -> {}",
        export_id, format, rows_written, cancelled, file_path
    );

    Ok(ExportSummary { rows_written, file_path, cancelled })
}

/// Request cancellation of a running export. Takes effect between batches.
#[tauri::command]
pub async fn cancel_export(export_id: String) -> Result<(), String> {
    cancelled_exports().lock().unwrap().insert(export_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn row(pairs: &[(&str, serde_json::Value)]) -> serde_json::Map<String, serde_json::Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn csv_escapes_special_chars() {
        assert_eq!(csv_escape("plain"), "plain");
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_escape("line\nbreak"), "\"line\nbreak\"");
    }

    #[test]
    fn csv_export_writes_header_and_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.csv");
        let columns = vec![col("id"), col("name")];
        let mut w = FormatWriter::new("csv", path.to_str().unwrap(), "t", &columns).unwrap();
        w.write_batch(&columns, &[
            row(&[("id", serde_json::json!(1)), ("name", serde_json::json!("a,b"))]),
        ]).unwrap();
        w.finish().unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content.replace("\r\n", "\n"), "id,name\n1,\"a,b\"\n");
    }

    #[test]
    fn json_export_is_valid_json_across_batches() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.json");
        let columns = vec![col("x")];
        let mut w = FormatWriter::new("json", path.to_str().unwrap(), "t", &columns).unwrap();
        w.write_batch(&columns, &[row(&[("x", serde_json::json!(1))])]).unwrap();
        w.write_batch(&columns, &[row(&[("x", serde_json::json!(2))])]).unwrap();
        w.finish().unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0]["x"], 1);
    }

    #[test]
    fn sql_export_produces_insert_statements() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.sql");
        let columns = vec![col("id"), col("name")];
        let mut w = FormatWriter::new("sql", path.to_str().unwrap(), "users", &columns).unwrap();
        w.write_batch(&columns, &[
            row(&[("id", serde_json::json!(1)), ("name", serde_json::json!("o'hara"))]),
        ]).unwrap();
        w.finish().unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("INSERT INTO \"users\" (\"id\", \"name\") VALUES (1, 'o''hara');"));
    }

    #[test]
    fn unsupported_format_rejected() {
        let result = FormatWriter::new("parquet", "x", "t", &[]);
        assert!(matches!(result, Err(DbError::ConfigError(_))));
    }
}
