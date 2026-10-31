pub(crate) mod commands;
mod lifecycle;
mod types;

pub(crate) use lifecycle::{
    acquire_project_class_reset_guard, shutdown_project_agent_sessions,
};
#[cfg(test)]
pub(crate) use lifecycle::{
    register_test_session_via_spawn_key_derivation, session_activity_for_project,
};
pub use types::new_project_agent_registry;
pub(crate) use types::ProjectAgentRegistry;
