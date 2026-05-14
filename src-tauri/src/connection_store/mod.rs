mod commands;
mod encryption;
mod models;

pub use commands::*;
pub use models::{Connection, DbType};

use encryption::{decrypt, encrypt, init_master_key};
use models::{ConnectionGroup, ConnectionGroupMapping, Metadata};
use chrono::Utc;
use rusqlite::{params, OptionalExtension, Connection as SqliteConnection};
use std::sync::{Arc, Mutex};

pub struct ConnectionStore {
    db: Arc<Mutex<SqliteConnection>>,
}

impl ConnectionStore {
    /// Create a new connection store
    pub fn new(db_path: &str) -> Result<Self, String> {
        println!("[ConnectionStore] 初始化, 数据库路径: {}", db_path);
        let conn = SqliteConnection::open(db_path).map_err(|e: rusqlite::Error| e.to_string())?;
        
        // Initialize tables
        Self::init_schema(&conn)?;
        println!("[ConnectionStore] 数据库表结构初始化完成");
        
        // Initialize master key for encryption
        init_master_key()?;
        println!("[ConnectionStore] 加密主密钥初始化完成");
        
        Ok(Self {
            db: Arc::new(Mutex::new(conn)),
        })
    }

    /// Initialize database schema
    fn init_schema(conn: &SqliteConnection) -> Result<(), String> {
        conn.execute_batch(
            "
            -- Connections table
            CREATE TABLE IF NOT EXISTS connections (
                id TEXT PRIMARY KEY,
                name TEXT UNIQUE NOT NULL,
                db_type TEXT NOT NULL,
                host TEXT,
                port INTEGER,
                username TEXT,
                password_encrypted TEXT,
                database TEXT,
                enable_ssl BOOLEAN DEFAULT 0,
                ssl_ca_cert TEXT,
                ssl_client_cert TEXT,
                ssl_client_key TEXT,
                ssh_tunnel_enabled BOOLEAN DEFAULT 0,
                ssh_host TEXT,
                ssh_port INTEGER,
                ssh_username TEXT,
                ssh_password_encrypted TEXT,
                ssh_private_key TEXT,
                keepalive_interval INTEGER DEFAULT 30,
                auto_reconnect BOOLEAN DEFAULT 1,
                color_label TEXT,
                tags TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_connected_at TIMESTAMP,
                connection_count INTEGER DEFAULT 0
            );

            -- Connection groups table
            CREATE TABLE IF NOT EXISTS connection_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT REFERENCES connection_groups(id),
                sort_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Connection-Group mapping table
            CREATE TABLE IF NOT EXISTS connection_group_mapping (
                connection_id TEXT REFERENCES connections(id) ON DELETE CASCADE,
                group_id TEXT REFERENCES connection_groups(id) ON DELETE CASCADE,
                PRIMARY KEY (connection_id, group_id)
            );

            -- Metadata table
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            -- Indexes for better performance
            CREATE INDEX IF NOT EXISTS idx_connections_name ON connections(name);
            CREATE INDEX IF NOT EXISTS idx_connections_db_type ON connections(db_type);
            CREATE INDEX IF NOT EXISTS idx_groups_parent ON connection_groups(parent_id);
            ",
        )
        .map_err(|e: rusqlite::Error| e.to_string())?;

        Ok(())
    }

    // ===== Connection CRUD Operations =====

    /// Create a new connection
    pub fn create_connection(&self, conn: &Connection) -> Result<(), String> {
        println!("[ConnectionStore::create] id={}, name={}, db_type={:?}, host={:?}:{:?}", conn.id, conn.name, conn.db_type, conn.host, conn.port);
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        let now = Utc::now().to_rfc3339();
        
        // Encrypt password if present
        let password_encrypted = if let Some(ref password) = get_password_for_encryption(conn) {
            println!("[ConnectionStore::create] 正在加密密码...");
            Some(encrypt(password)?)
        } else {
            None
        };

        // Encrypt SSH password if present
        let ssh_password_encrypted = if conn.ssh_tunnel_enabled {
            conn.ssh_password_encrypted
                .as_ref()
                .map(|pwd| encrypt(pwd))
                .transpose()?
        } else {
            None
        };

        db.execute(
            "INSERT INTO connections (
                id, name, db_type, host, port, username, password_encrypted,
                database, enable_ssl, ssl_ca_cert, ssl_client_cert, ssl_client_key,
                ssh_tunnel_enabled, ssh_host, ssh_port, ssh_username, ssh_password_encrypted,
                ssh_private_key, keepalive_interval, auto_reconnect, color_label, tags,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                conn.id,
                conn.name,
                conn.db_type.as_str(),
                conn.host,
                conn.port,
                conn.username,
                password_encrypted,
                conn.database,
                if conn.enable_ssl { 1 } else { 0 },
                conn.ssl_ca_cert,
                conn.ssl_client_cert,
                conn.ssl_client_key,
                if conn.ssh_tunnel_enabled { 1 } else { 0 },
                conn.ssh_host,
                conn.ssh_port,
                conn.ssh_username,
                ssh_password_encrypted,
                conn.ssh_private_key,
                conn.keepalive_interval,
                if conn.auto_reconnect { 1 } else { 0 },
                conn.color_label,
                conn.tags,
                now,
                now,
            ],
        )
        .map_err(|e: rusqlite::Error| e.to_string())?;

        println!("[ConnectionStore::create] 成功写入 SQLite, id={}", conn.id);
        Ok(())
    }

    /// Get all connections
    pub fn get_all_connections(&self) -> Result<Vec<Connection>, String> {
        println!("[ConnectionStore::get_all] 查询所有连接...");
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        let mut stmt = db
            .prepare(
                "SELECT * FROM connections ORDER BY created_at DESC",
            )
            .map_err(|e: rusqlite::Error| e.to_string())?;

        let connections = stmt
            .query_map([], |row: &rusqlite::Row| {
                let mut conn = Connection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    db_type: DbType::from_str(&row.get::<_, String>(2)?)
                        .unwrap_or(DbType::PostgreSQL),
                    host: row.get(3)?,
                    port: row.get(4)?,
                    username: row.get(5)?,
                    password_encrypted: row.get(6)?,
                    database: row.get(7)?,
                    enable_ssl: row.get::<_, i32>(8)? == 1,
                    ssl_ca_cert: row.get(9)?,
                    ssl_client_cert: row.get(10)?,
                    ssl_client_key: row.get(11)?,
                    ssh_tunnel_enabled: row.get::<_, i32>(12)? == 1,
                    ssh_host: row.get(13)?,
                    ssh_port: row.get(14)?,
                    ssh_username: row.get(15)?,
                    ssh_password_encrypted: row.get(16)?,
                    ssh_private_key: row.get(17)?,
                    keepalive_interval: row.get(18)?,
                    auto_reconnect: row.get::<_, i32>(19)? == 1,
                    color_label: row.get(20)?,
                    tags: row.get(21)?,
                    created_at: row.get(22)?,
                    updated_at: row.get(23)?,
                    last_connected_at: row.get(24)?,
                    connection_count: row.get(25)?,
                };

                // Decrypt password
                if let Some(encrypted_pwd) = &conn.password_encrypted {
                    if let Ok(pwd) = decrypt(encrypted_pwd) {
                        // Store decrypted password temporarily for backend use
                        // Note: In production, you might want a different approach
                        conn.password_encrypted = Some(pwd);
                    }
                }

                // Decrypt SSH password
                if let Some(encrypted_ssh_pwd) = &conn.ssh_password_encrypted {
                    if let Ok(pwd) = decrypt(encrypted_ssh_pwd) {
                        conn.ssh_password_encrypted = Some(pwd);
                    }
                }

                Ok(conn)
            })
            .map_err(|e| e.to_string())?;

        let mut result = Vec::new();
        for conn in connections {
            result.push(conn.map_err(|e| e.to_string())?);
        }

        println!("[ConnectionStore::get_all] 查询到 {} 个连接", result.len());
        Ok(result)
    }

    /// Get connection by ID
    pub fn get_connection(&self, id: &str) -> Result<Option<Connection>, String> {
        println!("[ConnectionStore::get_by_id] 查询连接 id={}", id);
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        let mut stmt = db
            .prepare("SELECT * FROM connections WHERE id = ?")
            .map_err(|e| e.to_string())?;

        let conn = stmt
            .query_row(params![id], |row| {
                let mut conn = Connection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    db_type: DbType::from_str(&row.get::<_, String>(2)?)
                        .unwrap_or(DbType::PostgreSQL),
                    host: row.get(3)?,
                    port: row.get(4)?,
                    username: row.get(5)?,
                    password_encrypted: row.get(6)?,
                    database: row.get(7)?,
                    enable_ssl: row.get::<_, i32>(8)? == 1,
                    ssl_ca_cert: row.get(9)?,
                    ssl_client_cert: row.get(10)?,
                    ssl_client_key: row.get(11)?,
                    ssh_tunnel_enabled: row.get::<_, i32>(12)? == 1,
                    ssh_host: row.get(13)?,
                    ssh_port: row.get(14)?,
                    ssh_username: row.get(15)?,
                    ssh_password_encrypted: row.get(16)?,
                    ssh_private_key: row.get(17)?,
                    keepalive_interval: row.get(18)?,
                    auto_reconnect: row.get::<_, i32>(19)? == 1,
                    color_label: row.get(20)?,
                    tags: row.get(21)?,
                    created_at: row.get(22)?,
                    updated_at: row.get(23)?,
                    last_connected_at: row.get(24)?,
                    connection_count: row.get(25)?,
                };

                // Decrypt password
                if let Some(encrypted_pwd) = &conn.password_encrypted {
                    if let Ok(pwd) = decrypt(encrypted_pwd) {
                        conn.password_encrypted = Some(pwd);
                    }
                }

                // Decrypt SSH password
                if let Some(encrypted_ssh_pwd) = &conn.ssh_password_encrypted {
                    if let Ok(pwd) = decrypt(encrypted_ssh_pwd) {
                        conn.ssh_password_encrypted = Some(pwd);
                    }
                }

                Ok(conn)
            })
            .optional()
            .map_err(|e| e.to_string())?;

        Ok(conn)
    }

    /// Update connection
    pub fn update_connection(&self, conn: &Connection) -> Result<(), String> {
        println!("[ConnectionStore::update] id={}, name={}, db_type={:?}", conn.id, conn.name, conn.db_type);
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        let now = Utc::now().to_rfc3339();

        // Encrypt password if changed
        let password_encrypted = if let Some(ref password) = get_password_for_encryption(conn) {
            Some(encrypt(password)?)
        } else {
            None
        };

        // Encrypt SSH password if present
        let ssh_password_encrypted = if conn.ssh_tunnel_enabled {
            conn.ssh_password_encrypted
                .as_ref()
                .map(|pwd| encrypt(pwd))
                .transpose()?
        } else {
            None
        };

        db.execute(
            "UPDATE connections SET
                name = ?, db_type = ?, host = ?, port = ?, username = ?,
                password_encrypted = ?, database = ?, enable_ssl = ?,
                ssl_ca_cert = ?, ssl_client_cert = ?, ssl_client_key = ?,
                ssh_tunnel_enabled = ?, ssh_host = ?, ssh_port = ?,
                ssh_username = ?, ssh_password_encrypted = ?, ssh_private_key = ?,
                keepalive_interval = ?, auto_reconnect = ?, color_label = ?, tags = ?,
                updated_at = ?
            WHERE id = ?",
            params![
                conn.name,
                conn.db_type.as_str(),
                conn.host,
                conn.port,
                conn.username,
                password_encrypted,
                conn.database,
                if conn.enable_ssl { 1 } else { 0 },
                conn.ssl_ca_cert,
                conn.ssl_client_cert,
                conn.ssl_client_key,
                if conn.ssh_tunnel_enabled { 1 } else { 0 },
                conn.ssh_host,
                conn.ssh_port,
                conn.ssh_username,
                ssh_password_encrypted,
                conn.ssh_private_key,
                conn.keepalive_interval,
                if conn.auto_reconnect { 1 } else { 0 },
                conn.color_label,
                conn.tags,
                now,
                conn.id,
            ],
        )
        .map_err(|e| e.to_string())?;

        println!("[ConnectionStore::update] 成功更新 SQLite, id={}", conn.id);
        Ok(())
    }

    /// Delete connection
    pub fn delete_connection(&self, id: &str) -> Result<(), String> {
        println!("[ConnectionStore::delete] 删除连接 id={}", id);
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        db.execute("DELETE FROM connections WHERE id = ?", params![id])
            .map_err(|e| e.to_string())?;

        println!("[ConnectionStore::delete] 成功从 SQLite 删除, id={}", id);
        Ok(())
    }

    /// Update connection statistics (last connected time, count)
    pub fn update_connection_stats(&self, id: &str) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        let now = Utc::now().to_rfc3339();
        
        db.execute(
            "UPDATE connections SET 
                last_connected_at = ?, 
                connection_count = connection_count + 1,
                updated_at = ?
            WHERE id = ?",
            params![now, now, id],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    // ===== Group Operations =====

    /// Create connection group
    pub fn create_group(&self, group: &ConnectionGroup) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        let now = Utc::now().to_rfc3339();
        
        db.execute(
            "INSERT INTO connection_groups (id, name, parent_id, sort_order, created_at)
             VALUES (?, ?, ?, ?, ?)",
            params![group.id, group.name, group.parent_id, group.sort_order, now],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Get all groups
    pub fn get_all_groups(&self) -> Result<Vec<ConnectionGroup>, String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        let mut stmt = db
            .prepare("SELECT * FROM connection_groups ORDER BY sort_order, name")
            .map_err(|e| e.to_string())?;

        let groups = stmt
            .query_map([], |row| {
                Ok(ConnectionGroup {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row.get(2)?,
                    sort_order: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e: rusqlite::Error| e.to_string())?;

        let mut result = Vec::new();
        for group in groups {
            result.push(group.map_err(|e: rusqlite::Error| e.to_string())?);
        }

        Ok(result)
    }

    /// Add connection to group
    pub fn add_connection_to_group(
        &self,
        connection_id: &str,
        group_id: &str,
    ) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        db.execute(
            "INSERT OR IGNORE INTO connection_group_mapping (connection_id, group_id)
             VALUES (?, ?)",
            params![connection_id, group_id],
        )
        .map_err(|e: rusqlite::Error| e.to_string())?;

        Ok(())
    }

    /// Get connections in group
    pub fn get_connections_in_group(&self, group_id: &str) -> Result<Vec<Connection>, String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        let mut stmt = db
            .prepare(
                "SELECT c.* FROM connections c
                 INNER JOIN connection_group_mapping m ON c.id = m.connection_id
                 WHERE m.group_id = ?
                 ORDER BY c.created_at DESC",
            )
            .map_err(|e: rusqlite::Error| e.to_string())?;

        let connections = stmt
            .query_map(params![group_id], |row: &rusqlite::Row| {
                let mut conn = Connection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    db_type: DbType::from_str(&row.get::<_, String>(2)?)
                        .unwrap_or(DbType::PostgreSQL),
                    host: row.get(3)?,
                    port: row.get(4)?,
                    username: row.get(5)?,
                    password_encrypted: row.get(6)?,
                    database: row.get(7)?,
                    enable_ssl: row.get::<_, i32>(8)? == 1,
                    ssl_ca_cert: row.get(9)?,
                    ssl_client_cert: row.get(10)?,
                    ssl_client_key: row.get(11)?,
                    ssh_tunnel_enabled: row.get::<_, i32>(12)? == 1,
                    ssh_host: row.get(13)?,
                    ssh_port: row.get(14)?,
                    ssh_username: row.get(15)?,
                    ssh_password_encrypted: row.get(16)?,
                    ssh_private_key: row.get(17)?,
                    keepalive_interval: row.get(18)?,
                    auto_reconnect: row.get::<_, i32>(19)? == 1,
                    color_label: row.get(20)?,
                    tags: row.get(21)?,
                    created_at: row.get(22)?,
                    updated_at: row.get(23)?,
                    last_connected_at: row.get(24)?,
                    connection_count: row.get(25)?,
                };

                if let Some(encrypted_pwd) = &conn.password_encrypted {
                    if let Ok(pwd) = decrypt(encrypted_pwd) {
                        conn.password_encrypted = Some(pwd);
                    }
                }

                if let Some(encrypted_ssh_pwd) = &conn.ssh_password_encrypted {
                    if let Ok(pwd) = decrypt(encrypted_ssh_pwd) {
                        conn.ssh_password_encrypted = Some(pwd);
                    }
                }

                Ok(conn)
            })
            .map_err(|e| e.to_string())?;

        let mut result = Vec::new();
        for conn in connections {
            result.push(conn.map_err(|e| e.to_string())?);
        }
        Ok(result)
    }

    // ===== Metadata Operations =====

    /// Set metadata
    pub fn set_metadata(&self, key: &str, value: &str) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        let now = Utc::now().to_rfc3339();
        
        db.execute(
            "INSERT OR REPLACE INTO metadata (key, value, created_at)
             VALUES (?, ?, ?)",
            params![key, value, now],
        )
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Get metadata
    pub fn get_metadata(&self, key: &str) -> Result<Option<String>, String> {
        let db = self.db.lock().map_err(|e| e.to_string())?;
        
        let mut stmt = db.prepare("SELECT value FROM metadata WHERE key = ?").map_err(|e| e.to_string())?;
        let result: Option<String> = stmt
            .query_row(params![key], |row| row.get(0))
            .optional()
            .map_err(|e| e.to_string())?;

        Ok(result)
    }
}

// Helper function to get password for encryption
fn get_password_for_encryption(conn: &Connection) -> Option<String> {
    conn.password_encrypted.clone()
}
