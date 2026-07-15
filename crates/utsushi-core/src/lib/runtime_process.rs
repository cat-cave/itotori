use std::io;
use std::process::{Child, ExitStatus};
use std::thread;
use std::time::{Duration, Instant};

use super::{RuntimeProcessCleanup, RuntimeProcessCleanupScope};

pub(super) fn wait_for_child_exit(
    child: &mut Child,
    timeout: Duration,
    poll_interval: Duration,
) -> io::Result<Option<ExitStatus>> {
    let started_at = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let elapsed = started_at.elapsed();
        if elapsed >= timeout {
            return Ok(None);
        }
        let remaining = timeout.saturating_sub(elapsed);
        thread::sleep(if remaining < poll_interval {
            remaining
        } else {
            poll_interval
        });
    }
}

pub(super) fn terminate_runtime_process(
    child: &mut Child,
    shutdown_grace: Duration,
    poll_interval: Duration,
) -> RuntimeProcessCleanup {
    if matches!(child.try_wait(), Ok(Some(_))) {
        match process_tree_exists(child.id()) {
            Ok(false) => {
                return RuntimeProcessCleanup {
                    attempted: false,
                    completed: true,
                    scope: RuntimeProcessCleanupScope::ProcessTree,
                    escalated: false,
                };
            }
            Ok(true) => {}
            Err(_) => {
                return RuntimeProcessCleanup {
                    attempted: false,
                    completed: false,
                    scope: RuntimeProcessCleanupScope::ProcessTree,
                    escalated: false,
                };
            }
        }
    }

    let attempted = terminate_process_tree(child.id()).is_ok();
    match wait_for_runtime_process_tree_exit(child, child.id(), shutdown_grace, poll_interval) {
        Ok(true) => {
            return RuntimeProcessCleanup {
                attempted,
                completed: true,
                scope: RuntimeProcessCleanupScope::ProcessTree,
                escalated: false,
            };
        }
        Ok(false) => {}
        Err(_) => {
            return RuntimeProcessCleanup {
                attempted,
                completed: false,
                scope: RuntimeProcessCleanupScope::ProcessTree,
                escalated: false,
            };
        }
    }

    let escalated = kill_process_tree(child.id()).is_ok();
    match wait_for_runtime_process_tree_exit(child, child.id(), shutdown_grace, poll_interval) {
        Ok(true) => RuntimeProcessCleanup {
            attempted,
            completed: true,
            scope: RuntimeProcessCleanupScope::ProcessTree,
            escalated,
        },
        Ok(false) | Err(_) => RuntimeProcessCleanup {
            attempted,
            completed: false,
            scope: RuntimeProcessCleanupScope::ProcessTree,
            escalated,
        },
    }
}

fn wait_for_runtime_process_tree_exit(
    child: &mut Child,
    process_id: u32,
    timeout: Duration,
    poll_interval: Duration,
) -> io::Result<bool> {
    let started_at = Instant::now();
    loop {
        let child_exited = child.try_wait()?.is_some();
        if child_exited && !process_tree_exists(process_id)? {
            return Ok(true);
        }
        let elapsed = started_at.elapsed();
        if elapsed >= timeout {
            return Ok(false);
        }
        let remaining = timeout.saturating_sub(elapsed);
        thread::sleep(if remaining < poll_interval {
            remaining
        } else {
            poll_interval
        });
    }
}

#[cfg(unix)]
fn terminate_process_tree(process_id: u32) -> io::Result<()> {
    unix_signal_process_group(process_id, unix_signals::SIGTERM)
}

#[cfg(unix)]
fn kill_process_tree(process_id: u32) -> io::Result<()> {
    unix_signal_process_group(process_id, unix_signals::SIGKILL)
}

#[cfg(unix)]
fn process_tree_exists(process_id: u32) -> io::Result<bool> {
    match unix_signal_process_group_raw(process_id, 0) {
        Ok(()) => Ok(true),
        Err(error) if error.raw_os_error() == Some(unix_signals::ESRCH) => Ok(false),
        Err(error) => Err(error),
    }
}

#[cfg(not(unix))]
fn terminate_process_tree(_process_id: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree cleanup is unsupported on this platform",
    ))
}

#[cfg(not(unix))]
fn kill_process_tree(_process_id: u32) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree cleanup is unsupported on this platform",
    ))
}

#[cfg(not(unix))]
fn process_tree_exists(_process_id: u32) -> io::Result<bool> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "process-tree cleanup is unsupported on this platform",
    ))
}

#[cfg(unix)]
fn unix_signal_process_group(process_id: u32, signal: i32) -> io::Result<()> {
    match unix_signal_process_group_raw(process_id, signal) {
        Ok(()) => Ok(()),
        Err(error) if error.raw_os_error() == Some(unix_signals::ESRCH) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
// reason: process-group signalling needs the libc kill(2) FFI; there is no safe
// std wrapper for negative-pgid delivery. Minimal unsafe surface.
#[allow(unsafe_code)]
fn unix_signal_process_group_raw(process_id: u32, signal: i32) -> io::Result<()> {
    let process_group_id = i32::try_from(process_id).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("process id {process_id} cannot be represented as a Unix process group id"),
        )
    })?;
    let result = unsafe { unix_signals::kill(-process_group_id, signal) };
    if result == 0 {
        return Ok(());
    }
    Err(io::Error::last_os_error())
}

#[cfg(unix)]
// reason: declares the libc kill(2) FFI symbol used by process-group signalling.
#[allow(unsafe_code)]
mod unix_signals {
    pub const ESRCH: i32 = 3;
    pub const SIGTERM: i32 = 15;
    pub const SIGKILL: i32 = 9;

    unsafe extern "C" {
        pub fn kill(pid: i32, sig: i32) -> i32;
    }
}
