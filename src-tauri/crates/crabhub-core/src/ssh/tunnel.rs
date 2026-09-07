use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use async_ssh2_lite::AsyncSession;
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::db::types::DbError;

#[derive(Debug, Clone)]
pub struct SshConfig {
    pub host: String, pub port: u16, pub username: String,
    pub password: Option<String>,
    #[allow(dead_code)]
    pub private_key: Option<String>,
}

/// Active SSH tunnel forwarding a local port to remote host:port.
pub struct SshTunnel {
    pub local_addr: SocketAddr,
    handle: Option<tokio::task::JoinHandle<()>>,
    shutdown: CancellationToken,
}

impl SshTunnel {
    pub async fn connect(
        ssh_config: &SshConfig,
        target_host: &str,
        target_port: u16,
    ) -> Result<Self, DbError> {
        let config = Arc::new(ssh_config.clone());
        let first_session = connect_session(&config).await?;
        let listener = TcpListener::bind("127.0.0.1:0").await
            .map_err(|e| DbError::ConnectionError(format!("SSH bind: {}", e)))?;
        let local_addr = listener.local_addr()
            .map_err(|e| DbError::ConnectionError(format!("SSH local addr: {}", e)))?;

        let target = target_host.to_string();
        let shutdown = CancellationToken::new();
        let cancelled = shutdown.clone();

        let handle = tokio::spawn(async move {
            let mut tasks = tokio::task::JoinSet::new();
            let mut first = Some(first_session);
            loop {
                tokio::select! {
                    biased;
                    _ = cancelled.cancelled() => break,
                    _ = tasks.join_next(), if !tasks.is_empty() => {},
                    accept = listener.accept(), if tasks.len() < 16 => {
                        let (local, _) = match accept { Ok(v) => v, Err(_) => break };
                        let config = config.clone();
                        let target = target.clone();
                        let initial = first.take();
                        tasks.spawn(async move {
                            let result = forward_one(config, initial, &target, target_port, local).await;
                            if let Err(error) = result { log::debug!("SSH forwarding stopped: {error}"); }
                        });
                    }
                }
            }
            tasks.abort_all();
            while tasks.join_next().await.is_some() {}
        });

        Ok(SshTunnel { local_addr, handle: Some(handle), shutdown })
    }

    pub async fn close(mut self) {
        self.shutdown.cancel();
        if let Some(mut handle) = self.handle.take() {
            if tokio::time::timeout(Duration::from_secs(5), &mut handle).await.is_err() {
                handle.abort();
                let _ = handle.await;
            }
        }
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.shutdown.cancel();
        if let Some(handle) = &self.handle { handle.abort(); }
    }
}

fn ssh_error(error: impl std::fmt::Display) -> DbError {
    DbError::ConnectionError(format!("SSH: {error}"))
}

fn verify_host(known: &mut ssh2::KnownHosts, host: &str, port: u16, key: &[u8], path: &Path) -> Result<(), DbError> {
    known.read_file(path, ssh2::KnownHostFileKind::OpenSSH)
        .map_err(|_| ssh_error("Cannot read known_hosts; configure CRABHUB_SSH_KNOWN_HOSTS or the user's .ssh/known_hosts"))?;
    match known.check_port(host, port, key) {
        ssh2::CheckResult::Match => Ok(()),
        _ => Err(ssh_error("Host key is unknown or changed; verify it with the server administrator before adding it to known_hosts")),
    }
}

async fn connect_session(config: &SshConfig) -> Result<AsyncSession<TcpStream>, DbError> {
    tokio::time::timeout(Duration::from_secs(15), async {
        let socket = TcpStream::connect((config.host.as_str(), config.port)).await.map_err(ssh_error)?;
        socket.set_nodelay(true).map_err(ssh_error)?;
        let mut session = AsyncSession::new(socket, None).map_err(ssh_error)?;
        session.handshake().await.map_err(ssh_error)?;
        let known_hosts = std::env::var_os("CRABHUB_SSH_KNOWN_HOSTS").map(std::path::PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".ssh/known_hosts")))
            .ok_or_else(|| ssh_error("Cannot locate known_hosts"))?;
        let key = session.host_key().ok_or_else(|| ssh_error("Server did not provide a host key"))?.0;
        verify_host(&mut session.known_hosts().map_err(ssh_error)?, &config.host, config.port, key, &known_hosts)?;
        if let Some(key) = &config.private_key {
            #[cfg(unix)]
            session.userauth_pubkey_memory(&config.username, None, key, None).await.map_err(ssh_error)?;
            #[cfg(not(unix))]
            { let _ = key; return Err(ssh_error("In-memory private-key authentication is unavailable on this platform; configure password authentication")); }
        } else {
            session.userauth_password(&config.username, config.password.as_deref().unwrap_or("")).await.map_err(ssh_error)?;
        }
        Ok(session)
    }).await.map_err(|_| ssh_error("Connection or authentication exceeded 15s"))?
}

async fn forward_one(config: Arc<SshConfig>, initial: Option<AsyncSession<TcpStream>>, target: &str, port: u16, mut local: TcpStream) -> Result<(), DbError> {
    let session = match initial { Some(session) => session, None => connect_session(&config).await? };
    let mut channel = tokio::time::timeout(Duration::from_secs(15), session.channel_direct_tcpip(target, port, None)).await
        .map_err(|_| ssh_error("Channel creation exceeded 15s"))?.map_err(ssh_error)?;
    tokio::io::copy_bidirectional(&mut local, &mut channel).await.map_err(ssh_error)?;
    let _ = tokio::time::timeout(Duration::from_secs(5), channel.close()).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_validation_requires_the_expected_key_and_port() {
        let session = ssh2::Session::new().unwrap();
        let mut known = session.known_hosts().unwrap();
        let key = b"test-host-key";
        known.add("[127.0.0.1]:2222", key, "test", ssh2::KnownHostKeyFormat::SshRsa.into()).unwrap();
        let file = tempfile::NamedTempFile::new().unwrap();
        known.write_file(file.path(), ssh2::KnownHostFileKind::OpenSSH).unwrap();
        assert!(verify_host(&mut session.known_hosts().unwrap(), "127.0.0.1", 2222, key, file.path()).is_ok());
        assert!(verify_host(&mut session.known_hosts().unwrap(), "127.0.0.1", 2223, key, file.path()).is_err());
        assert!(verify_host(&mut session.known_hosts().unwrap(), "127.0.0.1", 2222, b"wrong-key", file.path()).is_err());
    }
}

/// Create a TCP connection — direct or SSH tunneled.
#[allow(dead_code)]
pub async fn create_tcp_connection(
    host: &str, port: u16, ssh_config: Option<&SshConfig>,
) -> Result<TcpOrSsh, DbError> {
    if let Some(ssh) = ssh_config {
        log::info!("SSH tunnel: {}@{}:{} -> {}:{}", ssh.username, ssh.host, ssh.port, host, port);
        let tunnel = SshTunnel::connect(ssh, host, port).await?;
        let local_port = tunnel.local_addr.port();
        let stream = TcpStream::connect(format!("127.0.0.1:{}", local_port)).await
            .map_err(|e| DbError::ConnectionError(format!("SSH local: {}", e)))?;
        return Ok(TcpOrSsh::Ssh { stream, _tunnel: tunnel });
    }
    let addr: SocketAddr = format!("{}:{}", host, port).parse()
        .map_err(|e| DbError::ConnectionError(format!("Invalid address: {}", e)))?;
    let stream = TcpStream::connect(addr).await
        .map_err(|e| DbError::ConnectionError(format!("Connect: {}", e)))?;
    Ok(TcpOrSsh::Direct(stream))
}

#[allow(dead_code)]
pub enum TcpOrSsh {
    Direct(TcpStream),
    Ssh { stream: TcpStream, _tunnel: SshTunnel },
}

#[allow(dead_code)]
impl TcpOrSsh {
    pub fn into_tcp_stream(self) -> Result<TcpStream, DbError> {
        match self { TcpOrSsh::Direct(s) | TcpOrSsh::Ssh { stream: s, .. } => Ok(s) }
    }
}
