//! SSH tunnel support — EXPERIMENTAL.
//!
//! The types in `tunnel` are kept as a stable surface for future SSH-tunneled
//! database connections, but no driver currently consumes them. Treat this
//! module as a stub: changes here will not affect any active code path.

#![allow(dead_code)]

pub mod tunnel;

pub use tunnel::*;
