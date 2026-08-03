//! geo-compute — geospatial batch-compute sidecar for AgricPlatform.
//!
//! CPU-heavy geospatial work offloaded from the NestJS API: H3 indexing /
//! compaction (h3o), polygon validation & metrics, and geofence batch checks.
//! Fail-closed doctrine mirrors services/event-gw and services/crop-ml.

#![forbid(unsafe_code)]

pub mod config;
pub mod error;
pub mod geo;
pub mod h3ops;
pub mod handlers;
pub mod stub;
