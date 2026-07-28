//! First Siglus **runtime-VM** integration smoke.
//!
//! This module is the first Siglus VM *adapter skeleton*. It runs a **synthetic**
//! Siglus-shaped text-trace program through a tiny in-process interpreter and
//! emits **text** + **VM-state** evidence through the Utsushi runtime-evidence
//! contracts at the **E1** admission tier. It is deliberately *not* a Siglus VM:
//! the opcode set, container framing, and key scramble are authored synthetic
//! stand-ins. See `docs/utsushi-siglus-vm-provenance.md` for the clean-room
//! boundary this file was written under (recorded BEFORE this code).
//!
//! # What the smoke proves (honest scope)
//!
//! Given a synthetic Siglus-shaped text-trace program — optionally scrambled
//! with a **local** key referenced only by a [`SecretRef`] — the VM:
//!
//! 1. resolves the key **in-process** (never shelling out, never serializing raw
//!    key bytes); a posture that would need an external helper or an unavailable
//!    key is **rejected before the VM runs**
//! 2. descrambles + decodes the synthetic bytecode into a typed op stream
//! 3. executes it, emitting each dialogue line through a substrate
//!    [`TextSurfaceSink`] as an E1 [`TextLine`]
//! 4. exposes its flag/variable/PC state through the substrate
//!    [`Inspectable`] contract, captured as a [`Snapshot`] (the VM-state
//!    evidence)
//! 5. assembles a [`VmTraceEvidence`] runtime-evidence claim that references key
//!    material **only** through a secret-ref + one-way [`ProofHash`] commitment.
//!
//! # What it does NOT prove
//!
//! Real `Scene.pck` decode, the real Siglus opcode table, LZSS decompression
//! `Gameexe.dat` namespace resolution, or a rendered Siglus frame. Those are the
//! Research follow-ups enumerated in [`crate::vm_impl_map`].
//!
//! # Key discipline (mirrors )
//!
//! Raw key bytes live only inside the module-private, zeroize-on-drop
//! `Debug`-redacting [`VmKeyMaterial`] holder and never cross a serialization
//! boundary. The committed evidence carries a [`RuntimeKeyReference`]
//! (secret-ref + one-way commitment + byte length) — never the key.

include!("vm_parts/001.rs");
include!("vm_parts/002.rs");
