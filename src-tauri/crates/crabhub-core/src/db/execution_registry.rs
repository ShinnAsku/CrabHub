use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use super::types::DbError;

type ExecutionKey = (String, String);

#[derive(Default)]
struct Entries {
    active: HashMap<ExecutionKey, CancellationToken>,
    acknowledgements: HashMap<(ExecutionKey, usize), tokio::sync::oneshot::Sender<()>>,
    recent: VecDeque<(ExecutionKey, Instant)>,
}

pub struct ExecutionRegistry {
    entries: Mutex<Entries>,
    pub(crate) permits: Arc<Semaphore>,
    connections: Mutex<HashMap<String, Weak<Semaphore>>>,
}

impl Default for ExecutionRegistry {
    fn default() -> Self {
        Self { entries: Mutex::new(Entries::default()), permits: Arc::new(Semaphore::new(16)), connections: Mutex::new(HashMap::new()) }
    }
}

impl ExecutionRegistry {
    pub fn limits(&self, id: &str) -> ExecutionLimits {
        let mut connections = self.connections.lock().unwrap();
        connections.retain(|_, capacity| capacity.strong_count() > 0);
        let connection = connections.get(id).and_then(Weak::upgrade).unwrap_or_else(|| {
            let capacity = Arc::new(Semaphore::new(8));
            connections.insert(id.to_string(), Arc::downgrade(&capacity));
            capacity
        });
        ExecutionLimits { global: self.permits.clone(), connection }
    }

    pub fn expect_ack(&self, owner: &str, id: &str, sequence: usize, sender: tokio::sync::oneshot::Sender<()>) -> bool {
        let key = (owner.to_string(), id.to_string());
        let mut entries = self.entries.lock().unwrap();
        if !entries.active.contains_key(&key) || entries.acknowledgements.keys().any(|(current, _)| current == &key) {
            return false;
        }
        entries.acknowledgements.insert((key, sequence), sender);
        true
    }

    pub fn acknowledge(&self, owner: &str, id: &str, sequence: usize) -> bool {
        self.entries.lock().unwrap().acknowledgements
            .remove(&((owner.to_string(), id.to_string()), sequence))
            .is_some_and(|sender| sender.send(()).is_ok())
    }

    pub fn register(self: &Arc<Self>, owner: &str, id: &str) -> Result<ExecutionRegistration, DbError> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err(DbError::QueryError("executionId must be a UUID".into()));
        }
        let key = (owner.to_string(), id.to_string());
        let mut entries = self.entries.lock().unwrap();
        while entries.recent.front().is_some_and(|(_, finished)| finished.elapsed() > Duration::from_secs(300)) {
            entries.recent.pop_front();
        }
        if entries.active.len() >= 64 || entries.recent.len() >= 4096 {
            return Err(DbError::QueryError("Execution capacity exceeded; retry later".into()));
        }
        if entries.active.contains_key(&key) || entries.recent.iter().any(|(previous, _)| previous == &key) {
            return Err(DbError::QueryError("executionId has already been used".into()));
        }
        let cancel = CancellationToken::new();
        entries.active.insert(key.clone(), cancel.clone());
        Ok(ExecutionRegistration { registry: self.clone(), key, cancel })
    }

    pub fn cancel(&self, owner: &str, id: &str) -> bool {
        let entries = self.entries.lock().unwrap();
        if let Some(cancel) = entries.active.get(&(owner.to_string(), id.to_string())) {
            cancel.cancel();
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
pub struct ExecutionLimits {
    pub global: Arc<Semaphore>,
    pub connection: Arc<Semaphore>,
}

impl ExecutionLimits {
    pub async fn acquire(&self, cancel: &CancellationToken) -> Result<(tokio::sync::OwnedSemaphorePermit, tokio::sync::OwnedSemaphorePermit), DbError> {
        let acquire = async {
            let connection = self.connection.clone().acquire_owned().await
                .map_err(|_| DbError::ConnectionError("Connection execution queue closed".into()))?;
            let global = self.global.clone().acquire_owned().await
                .map_err(|_| DbError::ConnectionError("Global execution queue closed".into()))?;
            Ok((connection, global))
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(DbError::QueryError("Execution cancelled while queued".into())),
            result = tokio::time::timeout(Duration::from_secs(10), acquire) => result
                .map_err(|_| DbError::Timeout("Execution queue wait exceeded 10s".into()))?,
        }
    }
}

pub struct ExecutionRegistration {
    registry: Arc<ExecutionRegistry>,
    key: ExecutionKey,
    pub cancel: CancellationToken,
}

impl Drop for ExecutionRegistration {
    fn drop(&mut self) {
        self.cancel.cancel();
        let mut entries = self.registry.entries.lock().unwrap();
        entries.active.remove(&self.key);
        entries.acknowledgements.retain(|(key, _), _| key != &self.key);
        entries.recent.push_back((self.key.clone(), Instant::now()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn one_connection_cannot_consume_all_global_permits() {
        use futures_util::FutureExt;
        let registry = ExecutionRegistry::default();
        let first = registry.limits("first");
        let cancel = CancellationToken::new();
        let mut permits = Vec::new();
        for _ in 0..8 { permits.push(first.acquire(&cancel).await.unwrap()); }
        assert!(registry.limits("first").acquire(&cancel).now_or_never().is_none());
        assert_eq!(registry.permits.available_permits(), 8);
        let second = registry.limits("second").acquire(&cancel).await.unwrap();
        cancel.cancel();
        assert!(first.acquire(&cancel).await.is_err());
        drop((permits, second));
        assert_eq!(registry.permits.available_permits(), 16);
    }

    #[test]
    fn cancellation_is_scoped_and_execution_ids_cannot_be_replayed() {
        let registry = Arc::new(ExecutionRegistry::default());
        let first_id = uuid::Uuid::new_v4().to_string();
        let second_id = uuid::Uuid::new_v4().to_string();
        let first = registry.register("first-owner", &first_id).unwrap();
        let second = registry.register("first-owner", &second_id).unwrap();
        assert!(!registry.cancel("other-owner", &first_id));
        assert!(registry.cancel("first-owner", &first_id));
        assert!(first.cancel.is_cancelled());
        assert!(!second.cancel.is_cancelled());
        assert!(registry.register("first-owner", &first_id).is_err());
        drop(first);
        assert!(!registry.cancel("first-owner", &first_id));
        assert!(registry.register("first-owner", &first_id).is_err());
    }

    #[test]
    fn active_queue_is_bounded() {
        let registry = Arc::new(ExecutionRegistry::default());
        let tickets: Vec<_> = (0..64).map(|_| registry.register("test", &uuid::Uuid::new_v4().to_string()).unwrap()).collect();
        assert!(registry.register("test", &uuid::Uuid::new_v4().to_string()).is_err());
        drop(tickets);
        assert!(registry.register("test", &uuid::Uuid::new_v4().to_string()).is_ok());
    }

    #[test]
    fn progress_ack_requires_matching_owner_and_sequence() {
        let registry = Arc::new(ExecutionRegistry::default());
        let id = uuid::Uuid::new_v4().to_string();
        let registration = registry.register("owner", &id).unwrap();
        let (sender, mut receiver) = tokio::sync::oneshot::channel();
        assert!(registry.expect_ack("owner", &id, 0, sender));
        assert!(!registry.acknowledge("other", &id, 0));
        assert!(!registry.acknowledge("owner", &id, 1));
        assert!(receiver.try_recv().is_err());
        assert!(registry.acknowledge("owner", &id, 0));
        assert!(receiver.try_recv().is_ok());
        assert!(!registry.acknowledge("owner", &id, 0));
        drop(registration);
    }
}
