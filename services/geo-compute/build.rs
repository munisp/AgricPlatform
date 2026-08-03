//! Build script: surfaces the *resolved* h3o crate version (from Cargo.lock)
//! as the `GEOCOMPUTE_H3O_VERSION` env var so `/readyz` can report the exact
//! geometry-engine version instead of the declared semver requirement.

use std::env;
use std::fs;
use std::path::Path;

fn h3o_version(lock: &str) -> Option<String> {
    // Cargo.lock packages look like:
    //   [[package]]
    //   name = "h3o"
    //   version = "0.9.5"
    //   ...
    let mut in_h3o = false;
    for line in lock.lines() {
        let line = line.trim();
        if line == "[[package]]" {
            in_h3o = false;
        } else if line == "name = \"h3o\"" {
            in_h3o = true;
        } else if in_h3o && line.starts_with("version = \"") {
            return line
                .strip_prefix("version = \"")
                .and_then(|rest| rest.strip_suffix('"'))
                .map(str::to_owned);
        }
    }
    None
}

fn main() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set by cargo");
    let lock_path = Path::new(&manifest_dir).join("Cargo.lock");
    println!("cargo:rerun-if-changed={}", lock_path.display());
    let version = fs::read_to_string(&lock_path)
        .ok()
        .and_then(|contents| h3o_version(&contents))
        .unwrap_or_else(|| "unknown".to_string());
    println!("cargo:rustc-env=GEOCOMPUTE_H3O_VERSION={version}");
}
