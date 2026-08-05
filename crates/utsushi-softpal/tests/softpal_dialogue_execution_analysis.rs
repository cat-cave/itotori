//! Synthetic mutation guards for the dialogue-execution investigation.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet, VecDeque};

use kaifuu_softpal::{CommandFamily, OpcodeScan};

include!("softpal_dialogue_execution_analysis/common.rs");
include!("softpal_dialogue_execution_analysis/cfg.rs");

mod script_only_slice {
    use super::*;
    include!("softpal_dialogue_execution_analysis/script_only_slice.rs");
}

mod point_entry_ranking {
    use super::*;
    include!("softpal_dialogue_execution_analysis/point_entry_ranking.rs");
}
