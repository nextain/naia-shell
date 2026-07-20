use super::*;
use agent_grpc::pb;
use pb::naia_agent_server::{NaiaAgent, NaiaAgentServer};
use std::sync::Arc;
use tokio::sync::Notify;
use tokio_stream::wrappers::TcpListenerStream;
use tonic::{Request, Response, Status};

#[derive(Clone, Copy)]
enum ShutdownBehavior {
    Accept,
    Reject,
    LoseAck,
}

struct FakeAgent {
    behavior: ShutdownBehavior,
    reload_started: Arc<Notify>,
    shutdown_accepted: Arc<Notify>,
}

#[tonic::async_trait]
impl NaiaAgent for FakeAgent {
    async fn reload_settings(
        &self,
        _request: Request<pb::ReloadSettingsRequest>,
    ) -> Result<Response<pb::SetWorkspaceResult>, Status> {
        self.reload_started.notify_one();
        std::future::pending().await
    }

    async fn shutdown(
        &self,
        request: Request<pb::ShutdownRequest>,
    ) -> Result<Response<pb::Ack>, Status> {
        assert_eq!(request.into_inner().nonce, "test-nonce");
        match self.behavior {
            ShutdownBehavior::Accept => {
                self.shutdown_accepted.notify_one();
                Ok(Response::new(pb::Ack { ok: true }))
            }
            ShutdownBehavior::Reject => Err(Status::unauthenticated("nonce rejected")),
            ShutdownBehavior::LoseAck => {
                self.shutdown_accepted.notify_one();
                std::future::pending().await
            }
        }
    }
}

struct FakeServer {
    addr: String,
    reload_started: Arc<Notify>,
    shutdown_accepted: Arc<Notify>,
    stop: Arc<Notify>,
    task: tokio::task::JoinHandle<()>,
}

impl FakeServer {
    async fn start(behavior: ShutdownBehavior) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let reload_started = Arc::new(Notify::new());
        let shutdown_accepted = Arc::new(Notify::new());
        let stop = Arc::new(Notify::new());
        let service = FakeAgent {
            behavior,
            reload_started: reload_started.clone(),
            shutdown_accepted: shutdown_accepted.clone(),
        };
        let stop_signal = stop.clone();
        let task = tokio::spawn(async move {
            tonic::transport::Server::builder()
                .add_service(NaiaAgentServer::new(service))
                .serve_with_incoming_shutdown(TcpListenerStream::new(listener), async move {
                    stop_signal.notified().await;
                })
                .await
                .unwrap();
        });
        Self {
            addr: addr.to_string(),
            reload_started,
            shutdown_accepted,
            stop,
            task,
        }
    }

    async fn stop(self) {
        self.stop.notify_one();
        self.task.await.unwrap();
    }
}

fn spawn_shutdown_dispatcher(
    addr: String,
    rpc_timeout: std::time::Duration,
) -> (
    tokio::sync::mpsc::UnboundedSender<AgentShutdownCommand>,
    tokio::task::JoinHandle<()>,
) {
    let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel();
    let dispatcher = tokio::spawn(agent_shutdown_dispatcher_with_timeout(
        addr,
        command_rx,
        rpc_timeout,
    ));
    (command_tx, dispatcher)
}

fn spawn_production_shutdown_dispatcher(
    addr: String,
) -> (
    tokio::sync::mpsc::UnboundedSender<AgentShutdownCommand>,
    tokio::task::JoinHandle<()>,
) {
    let (command_tx, command_rx) = tokio::sync::mpsc::unbounded_channel();
    let dispatcher = tokio::spawn(agent_shutdown_dispatcher(addr, command_rx));
    (command_tx, dispatcher)
}

struct ClockChild {
    clock_ms: Arc<std::sync::atomic::AtomicU64>,
    natural_exit_at: Option<std::time::Duration>,
    terminated: bool,
    terminate_calls: usize,
    fail_termination: bool,
}

impl DiscordChildLifecycle for ClockChild {
    fn request_termination(&mut self) -> std::io::Result<()> {
        self.terminate_calls += 1;
        if self.fail_termination {
            return Err(std::io::Error::other("injected termination failure"));
        }
        self.terminated = true;
        Ok(())
    }

    fn has_exited(&mut self) -> std::io::Result<bool> {
        Ok(self.terminated
            || self.natural_exit_at.is_some_and(|deadline| {
                std::time::Duration::from_millis(
                    self.clock_ms.load(std::sync::atomic::Ordering::SeqCst),
                ) >= deadline
            }))
    }
}

fn run_lifecycle(
    dispatcher: tokio::sync::mpsc::UnboundedSender<AgentShutdownCommand>,
    natural_exit_at: Option<std::time::Duration>,
    fail_termination: bool,
) -> (Result<(), String>, ClockChild, std::time::Duration, bool) {
    let clock_ms = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut child = ClockChild {
        clock_ms: clock_ms.clone(),
        natural_exit_at,
        terminated: false,
        terminate_calls: 0,
        fail_termination,
    };
    let now_clock = clock_ms.clone();
    let sleep_clock = clock_ms.clone();
    let mut termination_attempted = false;
    let result = graceful_shutdown_and_reap_agent_with(
        &mut child,
        &mut termination_attempted,
        dispatcher,
        "test-nonce".to_string(),
        move || {
            std::time::Duration::from_millis(now_clock.load(std::sync::atomic::Ordering::SeqCst))
        },
        move |duration| {
            sleep_clock.fetch_add(
                duration.as_millis() as u64,
                std::sync::atomic::Ordering::SeqCst,
            );
        },
    );
    let elapsed =
        std::time::Duration::from_millis(clock_ms.load(std::sync::atomic::Ordering::SeqCst));
    (result, child, elapsed, termination_attempted)
}

#[tokio::test]
async fn stalled_ordinary_unary_does_not_block_independent_shutdown_dispatcher() {
    let server = FakeServer::start(ShutdownBehavior::Accept).await;
    let mut ordinary_client = agent_grpc::AgentGrpc::connect(format!("http://{}", server.addr))
        .await
        .unwrap();
    let ordinary = tokio::spawn(async move { ordinary_client.reload_settings().await });
    server.reload_started.notified().await;

    let (command_tx, dispatcher) = spawn_production_shutdown_dispatcher(server.addr.clone());
    let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
    command_tx
        .send(AgentShutdownCommand {
            nonce: "test-nonce".to_string(),
            result: result_tx,
        })
        .unwrap();
    let outcome = tokio::task::spawn_blocking(move || {
        result_rx
            .recv_timeout(AGENT_SHUTDOWN_RPC_TIMEOUT + std::time::Duration::from_secs(1))
            .unwrap()
    })
    .await
    .unwrap();
    drop(command_tx);
    dispatcher.await.unwrap();

    assert_eq!(outcome, AgentShutdownOutcome::Accepted);
    assert!(
        !ordinary.is_finished(),
        "ordinary unary must still be stalled"
    );
    ordinary.abort();
    server.stop().await;
}

#[tokio::test]
async fn accepted_shutdown_with_lost_ack_waits_for_child_exit() {
    let server = FakeServer::start(ShutdownBehavior::LoseAck).await;
    let accepted = server.shutdown_accepted.notified();
    let (dispatcher_tx, dispatcher) =
        spawn_shutdown_dispatcher(server.addr.clone(), std::time::Duration::from_millis(25));
    let lifecycle = tokio::task::spawn_blocking(move || {
        run_lifecycle(
            dispatcher_tx,
            Some(std::time::Duration::from_secs(1)),
            false,
        )
    });
    accepted.await;

    let (result, child, elapsed, termination_attempted) = lifecycle.await.unwrap();

    assert_eq!(result, Ok(()));
    assert_eq!(elapsed, std::time::Duration::from_secs(1));
    assert_eq!(child.terminate_calls, 0);
    assert!(termination_attempted);
    dispatcher.await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn explicit_auth_rejection_forces_child_without_grace_wait() {
    let server = FakeServer::start(ShutdownBehavior::Reject).await;
    let (dispatcher_tx, dispatcher) =
        spawn_shutdown_dispatcher(server.addr.clone(), std::time::Duration::from_millis(100));

    let (result, child, elapsed, termination_attempted) =
        tokio::task::spawn_blocking(move || run_lifecycle(dispatcher_tx, None, false))
            .await
            .unwrap();

    assert_eq!(result, Ok(()));
    assert_eq!(elapsed, std::time::Duration::ZERO);
    assert_eq!(child.terminate_calls, 1);
    assert!(termination_attempted);
    dispatcher.await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn agent_watchdog_exit_at_30_seconds_fits_shell_35_second_observation() {
    let server = FakeServer::start(ShutdownBehavior::Accept).await;
    let (dispatcher_tx, dispatcher) =
        spawn_shutdown_dispatcher(server.addr.clone(), std::time::Duration::from_millis(100));

    let (result, child, elapsed, termination_attempted) = tokio::task::spawn_blocking(move || {
        run_lifecycle(
            dispatcher_tx,
            Some(std::time::Duration::from_secs(30)),
            false,
        )
    })
    .await
    .unwrap();

    assert_eq!(result, Ok(()));
    assert_eq!(elapsed, std::time::Duration::from_secs(30));
    assert!(elapsed < std::time::Duration::from_secs(35));
    assert_eq!(child.terminate_calls, 0);
    assert!(termination_attempted);
    dispatcher.await.unwrap();
    server.stop().await;
}

#[tokio::test]
async fn drop_after_failed_explicit_termination_skips_drain_and_preserves_owned_lease() {
    struct DropProbe {
        child: ClockChild,
        lease: Option<AgentChildLease>,
        authenticated_drains: usize,
    }

    let server = FakeServer::start(ShutdownBehavior::Reject).await;
    let (dispatcher_tx, dispatcher) =
        spawn_shutdown_dispatcher(server.addr.clone(), std::time::Duration::from_millis(100));
    let (explicit_result, child, _, termination_attempted) =
        tokio::task::spawn_blocking(move || run_lifecycle(dispatcher_tx, None, true))
            .await
            .unwrap();
    dispatcher.await.unwrap();
    assert_eq!(
        explicit_result,
        Err("discord_agent_terminate_failed".to_string())
    );
    assert!(termination_attempted);
    assert_eq!(child.terminate_calls, 1);

    let lease = AgentChildLease {
        version: 1,
        pid: Some(4242),
        nonce: "owned-test-lease".to_string(),
        marker: "--naia-agent-child=owned-test-lease".to_string(),
        started_at_ms: 1,
        runtime: Some(std::path::PathBuf::from("test-runtime")),
    };
    let stored_lease = Arc::new(std::sync::Mutex::new(Some(lease.clone())));
    let quarantines = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let removals = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut probe = DropProbe {
        child,
        lease: Some(lease),
        authenticated_drains: 0,
    };
    let read_store = stored_lease.clone();
    let restore_store = stored_lease.clone();
    let remove_store = stored_lease.clone();
    let quarantine_count = quarantines.clone();
    let removal_count = removals.clone();
    finish_agent_process_drop_with(
        &mut probe,
        termination_attempted,
        |probe| {
            probe.authenticated_drains += 1;
            true
        },
        |probe| probe.child.request_termination().is_ok(),
        |probe, child_reaped| {
            let lease = probe.lease.as_ref().unwrap();
            let outcome = cleanup_owned_agent_child_with(
                lease,
                child_reaped,
                true,
                OwnedAgentCleanupMode::Normal,
                || Ok(read_store.lock().unwrap().clone()),
                |value| {
                    *restore_store.lock().unwrap() = Some(value.clone());
                    Ok(())
                },
                || Ok(true),
                || Ok(()),
                || {
                    quarantine_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
                || {
                    removal_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    *remove_store.lock().unwrap() = None;
                    Ok(true)
                },
            );
            if outcome.complete(child_reaped) {
                probe.lease = None;
            }
        },
    );

    assert_eq!(probe.authenticated_drains, 0);
    assert_eq!(probe.child.terminate_calls, 2);
    assert!(
        probe.lease.is_some(),
        "failed reap must retain local ownership"
    );
    assert!(stored_lease.lock().unwrap().is_some());
    assert_eq!(quarantines.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert_eq!(removals.load(std::sync::atomic::Ordering::SeqCst), 0);
    server.stop().await;
}

#[cfg(unix)]
#[test]
fn actual_agent_process_drop_after_explicit_failure_forces_and_reaps_without_replaying_rpc() {
    let child = std::process::Command::new("sh")
        .args(["-c", "sleep 30"])
        .spawn()
        .unwrap();
    let pid = child.id();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (shutdown_tx, mut shutdown_rx) =
        tokio::sync::mpsc::unbounded_channel::<AgentShutdownCommand>();
    let process = AgentProcess {
        child,
        lease: None,
        discord_cleanup: None,
        tx,
        shutdown_tx,
        shutdown_nonce: zeroize::Zeroizing::new("test-nonce".to_string()),
        termination_attempted: true,
        grpc_addr: "127.0.0.1:1".to_string(),
    };

    drop(process);

    assert!(
        shutdown_rx.try_recv().is_err(),
        "Drop must not replay shutdown RPC"
    );
    let alive = unsafe { libc::kill(pid as libc::pid_t, 0) };
    assert_eq!(alive, -1, "Drop must reap the owned child");
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}
