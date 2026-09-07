use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

pub(crate) struct QueryInterrupt {
    interrupted: Arc<AtomicBool>,
    completed: bool,
}

impl QueryInterrupt {
    pub async fn install(connection: &mut sqlx::SqliteConnection) -> Result<Self, super::types::DbError> {
        let interrupted = Arc::new(AtomicBool::new(false));
        let observed = interrupted.clone();
        connection.lock_handle().await.map_err(super::session::sqlx_error)?
            .set_progress_handler(1000, move || !observed.load(Ordering::Relaxed));
        Ok(Self { interrupted, completed: false })
    }

    pub fn complete(&mut self) { self.completed = true; }

    pub fn detach(mut self) -> Arc<AtomicBool> {
        self.complete();
        self.interrupted.clone()
    }
}

impl Drop for QueryInterrupt {
    fn drop(&mut self) {
        if !self.completed { self.interrupted.store(true, Ordering::Relaxed); }
    }
}