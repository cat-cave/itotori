// @itotori-real-bytes-proof
//! Text-free evidence for the dialogue-execution investigation.
//!
//! This test deliberately reports offsets, dispatch keys, state-shape counts,
//! and hashes only.  It must never print private dialogue, speaker, or choice
//! payloads while exercising the staged retail inputs.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use kaifuu_softpal::{CommandFamily, OpcodeScan, PacArchive, ScriptScan, TextDat};
use utsushi_softpal::{RuntimeTraceEvent, SceneStep, SoftpalScene};

include!("softpal_dialogue_execution_analysis/common.rs");
include!("softpal_dialogue_execution_analysis/real_common.rs");
include!("softpal_dialogue_execution_analysis/cfg.rs");

mod real_corpus_ranking {
    use super::*;
    include!("softpal_dialogue_execution_analysis/real_corpus_ranking.rs");
}

mod call_contract {
    use super::*;
    include!("softpal_dialogue_execution_analysis/call_contract.rs");
}
