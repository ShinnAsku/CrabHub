use serde::{Deserialize, Serialize};
use std::{process::Stdio, time::{Duration, Instant}};
use tokio::{fs::File, io::{AsyncRead, AsyncReadExt}, process::Command, sync::Semaphore};

const OUTPUT_LIMIT: usize = 1024 * 1024;
static EXECUTIONS: Semaphore = Semaphore::const_new(4);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DockerConnection {
    Local { endpoint: String },
    #[serde(rename_all = "camelCase")]
    Ssh { host: String, user: String, port: u16, endpoint: String, identity_file: Option<String>, known_hosts_file: Option<String> },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerPlan {
    arguments: Vec<String>,
    confirmation_required: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    duration_ms: u128,
    truncated: bool,
}

#[tauri::command]
pub fn docker_plan(command: String) -> Result<DockerPlan, String> {
    if command.len() > 8192 || command.contains(['\0', '\n', '\r']) {
        return Err("Use one Docker command of at most 8192 bytes.".into());
    }
    let mut arguments = shlex::split(&command).ok_or("Unclosed command quote.")?;
    if arguments.first().is_some_and(|arg| arg == "docker") { arguments.remove(0); }
    if arguments.is_empty() || arguments.len() > 128 { return Err("Enter a Docker command.".into()); }
    for argument in &arguments {
        if matches!(argument.as_str(), ";" | "|" | "||" | "&&" | ">" | ">>" | "<") {
            return Err("Shell pipelines and redirection are not supported.".into());
        }
        if argument.starts_with("--host") || argument.starts_with("--context") || argument.starts_with("--config")
            || argument.starts_with("--tls") || argument.starts_with("-H") || argument == "-c" || argument.starts_with("-c=") {
            return Err("Choose the Docker endpoint in the connection settings.".into());
        }
    }
    let mut verb = arguments[0].as_str();
    if matches!(verb, "container" | "image" | "volume") {
        let subcommand = arguments.get(1).ok_or("A Docker subcommand is required.")?.as_str();
        verb = match (verb, subcommand) {
            ("container", "ls") => "ps",
            ("image", "ls") => "images",
            ("volume", "ls") => "volumes",
            ("container" | "image" | "volume", "inspect") => "inspect",
            ("container", "logs" | "top" | "stats" | "start" | "stop" | "restart" | "rm") => subcommand,
            ("image", "rm" | "pull" | "tag" | "history") => subcommand,
            _ => return Err("This Docker subcommand is not supported in the desktop manager.".into()),
        };
    }
    let confirmation_required = match verb {
        "ps" | "images" | "volumes" | "inspect" | "logs" | "top" | "stats" | "version" | "info" | "history" => false,
        "start" | "stop" | "restart" | "rm" | "rmi" | "pull" | "tag" => true,
        _ => return Err("Supported commands: ps, images, inspect, logs, top, stats, version, info, history, start, stop, restart, rm, rmi, pull, tag; container/image aliases and volume ls/inspect. Interactive exec, run, build, login and Compose are not supported.".into()),
    };
    if arguments.iter().any(|arg| arg == "--follow" || arg.starts_with("--follow=") || arg == "--attach" || arg == "--interactive" || arg == "--tty"
        || (arg.starts_with('-') && !arg.starts_with("--") && arg[1..].chars().any(|flag| matches!((verb, flag), ("logs", 'f') | ("start", 'a' | 'i'))))) {
        return Err("Interactive and following commands are not supported; use a logs snapshot.".into());
    }
    let is_logs = verb == "logs";
    if verb == "stats" {
        if arguments.iter().any(|arg| arg.starts_with("--no-stream=")) { return Err("Use stats --no-stream.".into()); }
        if !arguments.iter().any(|arg| arg == "--no-stream") { arguments.push("--no-stream".into()); }
    }
    if is_logs && !arguments.iter().any(|arg| arg == "--tail" || arg.starts_with("--tail=")) {
        arguments.push("--tail=200".into());
    }
    Ok(DockerPlan { arguments, confirmation_required })
}

fn socket_endpoint(endpoint: &str, remote: bool) -> Result<String, String> {
    let endpoint = if endpoint.is_empty() {
        if cfg!(windows) && !remote { "npipe:////./pipe/docker_engine" } else { "unix:///var/run/docker.sock" }
    } else { endpoint };
    let unix = endpoint.starts_with("unix:///") && endpoint.len() > 8;
    let pipe = !remote && endpoint.starts_with("npipe:////./pipe/") && endpoint.len() > 16;
    if !(unix || pipe) || endpoint.contains(['\0', '\n', '\r', '"']) || endpoint.len() > 1024 {
        return Err("Use a local unix:///absolute/socket or npipe:////./pipe/name endpoint; remote Docker requires SSH.".into());
    }
    Ok(endpoint.to_owned())
}

fn process_spec(connection: &DockerConnection, arguments: &[String]) -> Result<(&'static str, Vec<String>), String> {
    match connection {
        DockerConnection::Local { endpoint } => {
            let mut args = vec![format!("--host={}", socket_endpoint(endpoint, false)?)];
            args.extend_from_slice(arguments);
            Ok(("docker", args))
        }
        DockerConnection::Ssh { host, user, port, endpoint, identity_file, known_hosts_file } => {
            if host.is_empty() || host.len() > 253 || host.starts_with('-')
                || !host.chars().all(|ch| ch.is_ascii_alphanumeric() || "._-:".contains(ch))
                || user.is_empty() || user.len() > 128 || user.starts_with('-')
                || !user.chars().all(|ch| ch.is_ascii_alphanumeric() || "._-".contains(ch)) || *port == 0 {
                return Err("Enter a valid SSH host, user and port (1-65535).".into());
            }
            let mut args: Vec<String> = ["-T", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", "-oConnectTimeout=10",
                "-oPasswordAuthentication=no", "-oKbdInteractiveAuthentication=no", "-oForwardAgent=no", "-oForwardX11=no",
                "-oPermitLocalCommand=no", "-oClearAllForwardings=yes", "-oRemoteCommand=none"].iter().map(|arg| (*arg).into()).collect();
            for value in [identity_file, known_hosts_file].into_iter().flatten() {
                if value.contains(['\0', '\n', '\r', '"']) || value.len() > 2048 { return Err("Invalid SSH file path.".into()); }
            }
            if let Some(identity) = identity_file.as_ref().filter(|value| !value.is_empty()) { args.extend(["-i".into(), identity.clone()]); }
            if let Some(known_hosts) = known_hosts_file.as_ref().filter(|value| !value.is_empty()) { args.push(format!("-oUserKnownHostsFile=\"{}\"", known_hosts)); }
            args.extend(["-p".into(), port.to_string(), "-l".into(), user.clone(), "--".into(), host.clone()]);
            let mut docker = vec!["docker".to_owned(), format!("--host={}", socket_endpoint(endpoint, true)?)];
            docker.extend_from_slice(arguments);
            args.push(shlex::try_join(docker.iter().map(String::as_str)).map_err(|_| "Invalid command argument.")?);
            Ok(("ssh", args))
        }
    }
}

async fn capture(mut reader: impl AsyncRead + Unpin) -> std::io::Result<(String, bool)> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 { break; }
        let remaining = OUTPUT_LIMIT.saturating_sub(bytes.len());
        bytes.extend_from_slice(&buffer[..count.min(remaining)]);
        truncated |= count > remaining;
    }
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

#[tauri::command]
pub async fn docker_execute(connection: DockerConnection, command: String, confirmed: bool) -> Result<DockerOutput, String> {
    let plan = docker_plan(command)?;
    if plan.confirmation_required && !confirmed { return Err("Confirmation required before changing Docker resources.".into()); }
    run_process(&connection, &plan.arguments, None).await
}

#[tauri::command]
pub async fn docker_load(connection: DockerConnection, path: String, confirmed: bool) -> Result<DockerOutput, String> {
    if !confirmed { return Err("Confirmation required before importing Docker images.".into()); }
    if path.len() > 4096 || path.contains(['\0', '\n', '\r']) { return Err("Invalid image archive path.".into()); }
    let file = File::open(&path).await.map_err(|error| format!("Cannot open the image archive: {error}"))?;
    let metadata = file.metadata().await.map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 { return Err("Choose a non-empty Docker image archive file.".into()); }
    run_process(&connection, &["load".into()], Some(file)).await
}

async fn run_process(connection: &DockerConnection, arguments: &[String], input: Option<File>) -> Result<DockerOutput, String> {
    let (program, arguments) = process_spec(connection, arguments)?;
    let _permit = EXECUTIONS.try_acquire().map_err(|_| "Docker is busy. Wait for the current commands to finish.")?;
    let mut process = Command::new(program);
    let importing = input.is_some();
    process.args(arguments).stdin(if importing { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for name in ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"] { process.env_remove(name); }
    #[cfg(windows)]
    process.creation_flags(0x08000000);
    let started = Instant::now();
    let mut child = process.spawn().map_err(|error| format!("Cannot start {program}. Install Docker CLI / OpenSSH and check PATH: {error}"))?;
    let stdout = child.stdout.take().ok_or("Docker stdout unavailable.")?;
    let stderr = child.stderr.take().ok_or("Docker stderr unavailable.")?;
    let stdin = child.stdin.take();
    let upload = async {
        if let Some(mut file) = input {
            let mut writer = stdin.ok_or_else(|| std::io::Error::other("Docker stdin unavailable."))?;
            tokio::io::copy(&mut file, &mut writer).await?;
        }
        Ok::<(), std::io::Error>(())
    };
    let seconds = if importing { 600 } else { 30 };
    let result = tokio::time::timeout(Duration::from_secs(seconds), async {
        tokio::join!(capture(stdout), capture(stderr), child.wait(), upload)
    }).await;
    let (stdout, stderr, status, uploaded) = match result {
        Ok(output) => output,
        Err(_) => {
            let _ = child.kill().await;
            return Err(format!("Docker timed out after {seconds} seconds. The daemon may already have applied changes; refresh its state before retrying."));
        }
    };
    let (stdout, stdout_truncated) = stdout.map_err(|error| error.to_string())?;
    let (stderr, stderr_truncated) = stderr.map_err(|error| error.to_string())?;
    let status = status.map_err(|error| error.to_string())?;
    if status.success() { uploaded.map_err(|error| format!("Image transfer failed: {error}"))?; }
    Ok(DockerOutput { stdout, stderr, exit_code: status.code().unwrap_or(-1), duration_ms: started.elapsed().as_millis(), truncated: stdout_truncated || stderr_truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutations_require_confirmation() {
        for command in ["docker stop example", "container start example", "restart example", "rm example", "image rm example", "pull alpine", "tag source target"] {
            assert!(docker_plan(command.into()).unwrap().confirmation_required, "{command}");
        }
        for command in ["ps -a", "images", "container ls", "volume ls", "inspect example", "info", "logs example"] {
            assert!(!docker_plan(command.into()).unwrap().confirmation_required, "{command}");
        }
    }

    #[test]
    fn rejects_shells_plugins_endpoint_overrides_and_interactive_commands() {
        for command in ["sh -c id", "docker compose up", "docker exec test id", "run alpine", "ps | more", "--host=tcp://host ps", "ps -Htcp://host", "ps --context=other", "logs -ft test", "start -ai test", "stats --no-stream=false", "ps\ninfo", "ps '\0'"] {
            assert!(docker_plan(command.into()).is_err(), "{command}");
        }
    }

    #[test]
    fn bounds_logs_and_stats_and_preserves_quoted_arguments() {
        assert_eq!(docker_plan("logs example".into()).unwrap().arguments, ["logs", "example", "--tail=200"]);
        assert_eq!(docker_plan("stats".into()).unwrap().arguments, ["stats", "--no-stream"]);
        assert_eq!(docker_plan("ps --filter 'name=with space'".into()).unwrap().arguments[2], "name=with space");
        assert!(docker_plan("ps 'unterminated".into()).is_err());
    }

    #[test]
    fn ssh_is_strict_and_remote_arguments_round_trip_without_shell_execution() {
        let connection = DockerConnection::Ssh { host: "host.example".into(), user: "operator".into(), port: 2222, endpoint: String::new(), identity_file: None, known_hosts_file: None };
        let arguments = vec!["ps".into(), "--filter".into(), "name=x; touch /tmp/unwanted $(id) ' \"".into()];
        let (program, args) = process_spec(&connection, &arguments).unwrap();
        assert_eq!(program, "ssh");
        assert!(args.contains(&"-oStrictHostKeyChecking=yes".into()));
        assert!(args.contains(&"-oBatchMode=yes".into()));
        let remote = shlex::split(args.last().unwrap()).unwrap();
        assert_eq!(&remote[2..], &arguments);
    }

    #[test]
    fn rejects_unauthenticated_tcp_and_ssh_option_injection() {
        for endpoint in ["tcp://remote:2375", "https://remote:2376", "npipe:////remote/pipe/docker", "unix://"] { assert!(socket_endpoint(endpoint, false).is_err()); }
        let connection = DockerConnection::Ssh { host: "-oProxyCommand=evil".into(), user: "user".into(), port: 22, endpoint: String::new(), identity_file: None, known_hosts_file: None };
        assert!(process_spec(&connection, &["ps".into()]).is_err());
    }

    #[tokio::test]
    async fn output_is_bounded_and_drained() {
        let input = vec![b'a'; OUTPUT_LIMIT + 100];
        let (output, truncated) = capture(input.as_slice()).await.unwrap();
        assert_eq!(output.len(), OUTPUT_LIMIT);
        assert!(truncated);
    }

    #[tokio::test]
    async fn rejects_unconfirmed_write_before_starting_docker() {
        let error = docker_execute(DockerConnection::Local { endpoint: String::new() }, "stop never-touch-this".into(), false).await.unwrap_err();
        assert!(error.contains("Confirmation required"));
    }

    #[tokio::test]
    async fn archive_load_requires_confirmation_and_a_regular_nonempty_file() {
        let local = DockerConnection::Local { endpoint: String::new() };
        assert!(docker_load(local.clone(), "not-a-file".into(), false).await.unwrap_err().contains("Confirmation required"));
        let empty = tempfile::NamedTempFile::new().unwrap();
        assert!(docker_load(local.clone(), empty.path().to_string_lossy().into(), true).await.unwrap_err().contains("non-empty"));
        assert!(docker_load(local, "missing-archive-file.tar".into(), true).await.unwrap_err().contains("Cannot open"));
    }
}