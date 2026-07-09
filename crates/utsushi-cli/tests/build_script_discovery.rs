// reason: including build.rs as a module surfaces helpers not all used by every test path
#![allow(dead_code)]

#[path = "../build.rs"]
mod build_script;
