//! Real-byte evidence for command-overload routing.
//!
//! The command header is `0x23 type module opcode:u16 argc:u16 overload:u8`.
//! This test counts every decoded `(type, module, opcode, overload)` address
//! so the reported routing surface comes from bytes, not a hand-written table.

#[path = "support/real_corpus.rs"]
mod real_corpus;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use kaifuu_reallive::{Xor2DecScene, recover_and_decrypt_archive};
use utsushi_reallive::{BytecodeElement, decode_bytecode_stream, decompress_all_scenes};

#[derive(Debug, Default, PartialEq, Eq)]
struct OverloadReport {
    commands: usize,
    addresses: BTreeMap<(u8, u8, u16), BTreeSet<u8>>,
}

impl OverloadReport {
    fn merge(&mut self, other: Self) {
        self.commands += other.commands;
        for (address, overloads) in other.addresses {
            self.addresses.entry(address).or_default().extend(overloads);
        }
    }

    fn overload_distinguished_addresses(&self) -> usize {
        self.addresses
            .values()
            .filter(|overloads| overloads.len() > 1)
            .count()
    }

    fn previously_collapsed_operations(&self) -> usize {
        self.addresses
            .values()
            .map(|overloads| overloads.len().saturating_sub(1))
            .sum()
    }
}

fn report_for_archive(bytes: &[u8]) -> OverloadReport {
    let mut scenes = decompress_all_scenes(bytes).expect("decompress archive");
    let mut encrypted: Vec<Xor2DecScene> = scenes
        .iter()
        .map(|scene| Xor2DecScene {
            compiler_version: scene.compiler_version,
            bytecode: scene.bytecode.clone(),
        })
        .collect();
    let _ = recover_and_decrypt_archive(&mut encrypted);
    for (scene, decrypted) in scenes.iter_mut().zip(encrypted) {
        scene.bytecode = decrypted.bytecode;
    }

    let mut report = OverloadReport::default();
    for scene in scenes {
        let elements = decode_bytecode_stream(&scene.bytecode).expect("decode scene bytecode");
        for element in elements {
            if let BytecodeElement::Command {
                module_type,
                module_id,
                opcode,
                overload,
                ..
            } = element
            {
                report.commands += 1;
                report
                    .addresses
                    .entry((module_type, module_id, opcode))
                    .or_default()
                    .insert(overload);
            }
        }
    }
    report
}

#[test]
fn decoded_real_bytes_report_overload_distinguished_operations() {
    let corpora = real_corpus::corpora();
    if corpora.len() < 2 {
        real_corpus::require_real_bytes(
            "utsushi-reallive decoded_real_bytes_report_overload_distinguished_operations",
        );
        return;
    }

    let mut combined = OverloadReport::default();
    for corpus in corpora {
        let bytes = fs::read(&corpus.seen_txt).expect("read archive");
        let report = report_for_archive(&bytes);
        eprintln!(
            "[{}] commands={} addresses={} overload_distinguished={} previously_collapsed={}",
            corpus.label,
            report.commands,
            report.addresses.len(),
            report.overload_distinguished_addresses(),
            report.previously_collapsed_operations(),
        );
        assert!(
            report.commands > 0,
            "[{}] corpus must contain commands",
            corpus.label
        );
        combined.merge(report);
    }
    eprintln!(
        "[combined] commands={} addresses={} overload_distinguished={} previously_collapsed={} keys={:?}",
        combined.commands,
        combined.addresses.len(),
        combined.overload_distinguished_addresses(),
        combined.previously_collapsed_operations(),
        combined
            .addresses
            .iter()
            .filter(|(_, overloads)| overloads.len() > 1)
            .collect::<Vec<_>>(),
    );
    eprintln!(
        "[combined] nonzero-overload-keys={:?}",
        combined
            .addresses
            .iter()
            .flat_map(|(address, overloads)| overloads
                .iter()
                .filter(|&&overload| overload != 0)
                .map(move |&overload| (address, overload)))
            .collect::<Vec<_>>(),
    );
}
