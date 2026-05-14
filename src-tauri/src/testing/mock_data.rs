//! Mock data generator for stress testing.
//! Generates INSERT batches for configurable table schemas and row counts.

use rand::Rng;

pub struct MockColumn {
    pub name: String,
    pub data_type: MockDataType,
}

pub enum MockDataType {
    Integer { min: i64, max: i64 },
    Varchar { max_length: usize },
    Numeric { precision: u8, scale: u8 },
    Timestamp,
    Boolean,
    Uuid,
}

pub struct MockTableConfig {
    pub table_name: String,
    pub row_count: u32,
    pub columns: Vec<MockColumn>,
}

impl MockTableConfig {
    pub fn example_wide() -> Self {
        Self {
            table_name: "stress_test_wide".to_string(),
            row_count: 10_000,
            columns: (0..30)
                .map(|i| MockColumn {
                    name: format!("col_{}", i),
                    data_type: if i == 0 {
                        MockDataType::Integer { min: 1, max: 10_000_000 }
                    } else if i <= 5 {
                        MockDataType::Varchar { max_length: 255 }
                    } else if i <= 10 {
                        MockDataType::Numeric { precision: 18, scale: 2 }
                    } else if i <= 15 {
                        MockDataType::Timestamp
                    } else if i <= 20 {
                        MockDataType::Boolean
                    } else {
                        MockDataType::Uuid
                    },
                })
                .collect(),
        }
    }

    pub fn example_small() -> Self {
        Self {
            table_name: "stress_test_small".to_string(),
            row_count: 100_000,
            columns: vec![
                MockColumn { name: "id".into(), data_type: MockDataType::Integer { min: 1, max: 1_000_000 } },
                MockColumn { name: "name".into(), data_type: MockDataType::Varchar { max_length: 100 } },
                MockColumn { name: "amount".into(), data_type: MockDataType::Numeric { precision: 18, scale: 2 } },
                MockColumn { name: "created_at".into(), data_type: MockDataType::Timestamp },
                MockColumn { name: "active".into(), data_type: MockDataType::Boolean },
            ],
        }
    }
}

/// Generate a CREATE TABLE statement for the mock config
pub fn generate_create_table(config: &MockTableConfig) -> String {
    let col_defs: Vec<String> = config.columns.iter().map(|col| {
        let sql_type = match &col.data_type {
            MockDataType::Integer { .. } => "INTEGER".into(),
            MockDataType::Varchar { max_length } => format!("VARCHAR({})", max_length),
            MockDataType::Numeric { precision, scale } => format!("NUMERIC({},{})", precision, scale),
            MockDataType::Timestamp => "TIMESTAMP".into(),
            MockDataType::Boolean => "BOOLEAN".into(),
            MockDataType::Uuid => "VARCHAR(36)".into(),
        };
        format!("{} {}", col.name, sql_type)
    }).collect();
    format!("CREATE TABLE IF NOT EXISTS {} ({});", config.table_name, col_defs.join(", "))
}

/// Generate batched INSERT statements.
/// Returns batches of SQL strings, each containing up to `batch_size` rows.
pub fn generate_insert_batches(config: &MockTableConfig, batch_size: usize) -> Vec<String> {
    let mut rng = rand::thread_rng();
    let col_names: Vec<&str> = config.columns.iter().map(|c| c.name.as_str()).collect();
    let mut batches = Vec::new();

    for chunk_start in (0..config.row_count as usize).step_by(batch_size) {
        let chunk_end = std::cmp::min(chunk_start + batch_size, config.row_count as usize);
        let chunk_size = chunk_end - chunk_start;

        let value_rows: Vec<String> = (0..chunk_size).map(|_| {
            let vals: Vec<String> = config.columns.iter().map(|col| {
                match &col.data_type {
                    MockDataType::Integer { min, max } => rng.gen_range(*min..=*max).to_string(),
                    MockDataType::Varchar { max_length } => {
                        let len = rng.gen_range(1..=*max_length);
                        let s: String = (0..len).map(|_| rng.gen_range(b'a'..=b'z') as char).collect();
                        format!("'{}'", s.replace('\'', "''"))
                    }
                    MockDataType::Numeric { .. } => format!("{}", rng.gen_range(0.0..10000.0)),
                    MockDataType::Timestamp => {
                        let y = rng.gen_range(2020..=2026);
                        let m = rng.gen_range(1..=12);
                        let d = rng.gen_range(1..=28);
                        format!("'{}-{:02}-{:02} 12:00:00'", y, m, d)
                    }
                    MockDataType::Boolean => (rng.gen::<bool>()).to_string(),
                    MockDataType::Uuid => {
                        let id = uuid::Uuid::new_v4();
                        format!("'{}'", id)
                    }
                }
            }).collect();
            format!("({})", vals.join(", "))
        }).collect();

        let sql = format!(
            "INSERT INTO {} ({}) VALUES {};",
            config.table_name,
            col_names.join(", "),
            value_rows.join(",\n")
        );
        batches.push(sql);
    }

    batches
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_create_table() {
        let config = MockTableConfig::example_small();
        let sql = generate_create_table(&config);
        assert!(sql.contains("CREATE TABLE IF NOT EXISTS"));
        assert!(sql.contains("id INTEGER"));
        assert!(sql.contains("name VARCHAR"));
    }

    #[test]
    fn test_generate_insert_batches() {
        let config = MockTableConfig {
            table_name: "test".into(),
            row_count: 100,
            columns: vec![MockColumn {
                name: "val".into(),
                data_type: MockDataType::Integer { min: 0, max: 100 },
            }],
        };
        let batches = generate_insert_batches(&config, 30);
        assert_eq!(batches.len(), 4); // 4 batches: 30+30+30+10
    }
}
