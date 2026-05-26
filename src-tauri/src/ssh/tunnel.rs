use std::io::Read;
use std::io::Write;
use std::net::{SocketAddr, TcpStream as StdTcpStream};
use tokio::net::{TcpListener, TcpStream};

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
    handle: tokio::task::JoinHandle<()>,
    shutdown: tokio::sync::oneshot::Sender<()>,
}

impl SshTunnel {
    pub async fn connect(
        ssh_config: &SshConfig,
        target_host: &str,
        target_port: u16,
    ) -> Result<Self, DbError> {
        let listener = TcpListener::bind("127.0.0.1:0").await
            .map_err(|e| DbError::ConnectionError(format!("SSH bind: {}", e)))?;
        let local_addr = listener.local_addr()
            .map_err(|e| DbError::ConnectionError(format!("SSH local addr: {}", e)))?;

        let ssh_addr = format!("{}:{}", ssh_config.host, ssh_config.port);
        let ssh_user = ssh_config.username.clone();
        let ssh_pass = ssh_config.password.clone().unwrap_or_default();
        let ssh_key = ssh_config.private_key.clone();
        let target = format!("{}:{}", target_host, target_port);
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();

        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    accept = listener.accept() => {
                        let (local, _) = match accept { Ok(v) => v, Err(_) => break };
                        let a = ssh_addr.clone();
                        let u = ssh_user.clone();
                        let p = ssh_pass.clone();
                        let k = ssh_key.clone();
                        let t = target.clone();
                        tokio::task::spawn_blocking(move || forward_one(&a, &u, &p, k.as_deref(), &t, local)).await.ok();
                    }
                    _ = &mut shutdown_rx => break,
                }
            }
        });

        Ok(SshTunnel { local_addr, handle, shutdown: shutdown_tx })
    }

    pub async fn close(self) {
        let _ = self.shutdown.send(());
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), self.handle).await;
    }
}

fn forward_one(ssh_addr: &str, ssh_user: &str, ssh_pass: &str, ssh_key: Option<&str>, target: &str, local: TcpStream) {
    let tcp = match StdTcpStream::connect(ssh_addr) {
        Ok(t) => t,
        Err(e) => { log::debug!("SSH TCP: {}", e); return; }
    };
    tcp.set_nonblocking(false).ok();

    let mut session = match ssh2::Session::new() {
        Ok(s) => s,
        Err(e) => { log::debug!("SSH session: {}", e); return; }
    };
    session.set_tcp_stream(tcp);

    if let Err(e) = session.handshake() {
        log::debug!("SSH handshake: {}", e); return;
    }

    // Authenticate
    #[cfg(unix)]
    let authed = if let Some(key) = ssh_key {
        session.userauth_pubkey_memory(ssh_user, None, key, None).is_ok()
    } else { false };
    #[cfg(not(unix))]
    let authed = {
        if ssh_key.is_some() {
            log::warn!("SSH private key auth not supported on this platform — falling back to password");
        }
        false
    };
    if !authed {
        if let Err(e) = session.userauth_password(ssh_user, ssh_pass) {
            log::debug!("SSH auth: {}", e); return;
        }
    }

    let (t_host, t_port_str) = match target.rsplit_once(':') {
        Some(v) => v,
        None => { log::debug!("SSH bad target"); return; }
    };
    let t_port: u16 = match t_port_str.parse() {
        Ok(p) => p, Err(_) => { log::debug!("SSH bad port"); return; }
    };

    let mut channel = match session.channel_direct_tcpip(t_host, t_port, None) {
        Ok(c) => c,
        Err(e) => { log::debug!("SSH channel: {}", e); return; }
    };

    let mut local_std = match local.into_std() {
        Ok(s) => s,
        Err(e) => { log::debug!("SSH into_std: {}", e); return; }
    };
    local_std.set_nonblocking(false).ok();

    let mut buf = [0u8; 8192];
    loop {
        match channel.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => { if local_std.write_all(&buf[..n]).is_err() { break; } }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => break,
        }
        match read_nonblocking(&mut local_std, &mut buf) {
            Ok(0) => { std::thread::sleep(std::time::Duration::from_millis(10)); }
            Ok(n) => { if channel.write_all(&buf[..n]).is_err() { break; } }
            Err(_) => break,
        }
    }
}

fn read_nonblocking(s: &mut std::net::TcpStream, buf: &mut [u8]) -> std::io::Result<usize> {
    s.set_nonblocking(true)?;
    let result = s.read(buf);
    s.set_nonblocking(false)?;
    match result {
        Ok(n) => Ok(n),
        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(0),
        Err(e) => Err(e),
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
