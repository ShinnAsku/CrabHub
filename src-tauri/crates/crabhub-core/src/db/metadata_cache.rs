use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

use super::types::{ColumnInfo, TableInfo};

const TTL: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub(super) enum CachedMeta {
    Tables(Vec<TableInfo>),
    Schemas(Vec<String>),
    Columns(Vec<ColumnInfo>),
}

#[derive(Default)]
pub(super) struct MetadataCache {
    entries: RwLock<HashMap<String, (Instant, CachedMeta)>>,
}

impl MetadataCache {
    pub async fn get(&self, key: &str) -> Option<CachedMeta> {
        self.entries.read().await.get(key)
            .filter(|(stored_at, _)| stored_at.elapsed() < TTL)
            .map(|(_, value)| value.clone())
    }

    pub async fn put(&self, key: String, value: CachedMeta) {
        self.entries.write().await.insert(key, (Instant::now(), value));
    }

    pub async fn invalidate(&self, connection_id: &str) {
        let prefix = format!("{connection_id}\x00");
        self.entries.write().await.retain(|key, _| !key.starts_with(&prefix));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn expired_metadata_is_not_returned() {
        let cache = MetadataCache::default();
        let key = "connection\0schemas";
        cache.put(key.into(), CachedMeta::Schemas(vec!["main".into()])).await;
        assert!(matches!(cache.get(key).await, Some(CachedMeta::Schemas(schemas)) if schemas == ["main"]));
        cache.entries.write().await.get_mut(key).unwrap().0 = Instant::now() - TTL;
        assert!(cache.get(key).await.is_none());
    }

    #[tokio::test]
    async fn invalidation_preserves_other_connections_with_similar_ids() {
        let cache = MetadataCache::default();
        for key in ["connection\0schemas", "connection\0tables", "connection-other\0schemas"] {
            cache.put(key.into(), CachedMeta::Schemas(Vec::new())).await;
        }
        cache.invalidate("connection").await;
        assert!(cache.get("connection\0schemas").await.is_none());
        assert!(cache.get("connection\0tables").await.is_none());
        assert!(cache.get("connection-other\0schemas").await.is_some());
    }
}