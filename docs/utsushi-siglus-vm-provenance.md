# UTSUSHI-034 — Siglus VM clean-room provenance & implementation map

**Status:** authored _before_ any Siglus-VM adapter code (this document gates
`crates/utsushi-siglus/src/vm.rs`). It records what external Siglus references
were studied, their license/review status, and the clean-room boundary the VM
smoke was written under.

This is the first Siglus **runtime-VM** integration smoke. It is deliberately
narrow: a synthetic, in-process text-trace VM that emits _text_ and _VM-state_
evidence through the Utsushi runtime-evidence contracts at the **E1** admission
tier. It is **not** a Siglus VM — see _Honest scope_ below.

## 1. External references studied (research anchors only)

| reference                                                              | owner       | license (observed)                                                           | review status                                                                                     | how it was used                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `siglus_rs` (`https://github.com/xmoezzz/siglus_rs`)                   | xmoezzz     | **MPL-2.0**                                                                  | license field read on the public repo; **not** legally cleared for vendoring/porting into itotori | Research anchor for the _shape_ of a Siglus interpreter loop (opcode-dispatch / string-table / flag-bank subsystem boundaries). No source expression, structure layout, or opcode table copied. |
| `siglus-decompile` (`https://github.com/bluecookies/siglus-decompile`) | bluecookies | **no license file** → treated as **all-rights-reserved, documentation-only** | reference-only, never vendored                                                                    | Clearest human-readable description of Siglus bytecode structure. Read for understanding; nothing copied.                                                                                       |
| `SiglusExtract`                                                        | xmoezzz     | **GPLv3**                                                                    | reference-only, never vendored or linked                                                          | Container/`Scene.pck` extraction reference. Not used by this VM smoke (kept for the decode follow-ups).                                                                                         |
| `rlvm` / `xclannad`                                                    | —           | (RealLive engines)                                                           | explicitly out of scope                                                                           | Not Siglus. Named only to record that the Siglus port shares nothing with the RealLive port except the `utsushi-core` substrate facade.                                                         |

### siglus_rs license verdict (asked for explicitly)

`siglus_rs` is published under **MPL-2.0**. MPL-2.0 is a _file-level_ copyleft
that _would_ permit porting **if** we took a derived-work posture and preserved
the license on the ported files. **We do not take that posture.** itotori's
shipped distribution posture for this crate is the workspace-default
`MIT OR Apache-2.0`, and mixing an MPL-2.0-derived file into it would attach
MPL obligations we do not want to carry. Therefore:

> **The clean-room boundary here is stronger than MPL-2.0 requires: we vendor
> nothing, link nothing, and mechanically translate nothing. Every concept is
> re-derived from publicly-archived Siglus format documentation and this VM's
> own synthetic model, then authored fresh.** If a specific real-Siglus decode
> follow-up (§4) ever needs to lean on `siglus_rs` more directly, that is a
> separate licensing decision that must be recorded on that follow-up node
> _before_ code lands — it is **not** pre-authorized by this document.

## 2. Clean-room boundary — studied vs reimplemented

**Studied (concepts only, no code taken):**

- That a Siglus title runs a stack/register bytecode interpreter over
  `Scene.pck` scene bytecode, resolving strings from a UTF-16LE table and
  keeping flag/variable banks.
- That container access can require a key that a real title resolves in-process
  (never a shell-out) — the discipline already encoded by UTSUSHI-035's
  runtime-profile boundary.
- The _subsystem decomposition_ (decode → dispatch → string-table → banks →
  choices → custom callbacks) named in the implementation map (§4).

**Reimplemented clean (authored here, owes nothing to any reference):**

- The VM's opcode set (`SiglusTraceOp`: `EmitText` / `SetFlag` / `SetInt` /
  `Halt`) is a **synthetic** instruction set. It is **not** the real Siglus
  opcode table, and no claim is made that it matches Siglus bytecode.
- The synthetic bytecode container framing (magic + length-prefixed records) is
  authored for this smoke.
- The local-key XOR descramble is a synthetic stand-in for "the VM consumed a
  locally-resolvable key without ever serializing the raw key material". The
  key is an authored, clearly-fake constant; there is no retail key anywhere.
- All secret-ref / redaction / one-way-commitment discipline is **reused from
  UTSUSHI-035** (`SecretRef`, `ProofHash`, `RuntimeKeyReference`) — itotori's
  own code, not an external reference.

**Hard boundaries (crate-graph enforced):**

- No dependency on `siglus_rs` (source, object, or distribution). No headers,
  no structure layouts, no translated code.
- No `Command::new`, no Wine, no external helper. The key is resolved
  in-process; a posture that would need an external helper is _rejected_, never
  shelled out to.
- No retail bytes, no retail key committed. Every fixture is synthetic and
  authored from module constants.

## 3. Honest scope (what the smoke does and does NOT prove)

The VM smoke proves exactly one E1-tier claim: _given a synthetic Siglus-shaped
text-trace program (optionally locally-key-scrambled), the VM descrambles it
in-process using only a secret-ref-referenced key, executes it, and emits the
resulting text lines and VM state through the Utsushi runtime-evidence
contracts, serializing **no** raw key material._

It does **not** prove: that itotori can decode real `Scene.pck` bytecode, run
the real Siglus opcode set, decompress the proprietary LZSS container, resolve
`Gameexe.dat` namespaces, or render a Siglus frame. Those are the follow-ups.

## 4. Implementation map — concrete Siglus VM subsystem follow-ups

The typed, schema-validated map is built in
`crates/utsushi-siglus/src/vm_impl_map.rs` (`build_siglus_vm_impl_map()`),
validated by `crates/utsushi-siglus/tests/vm_smoke.rs`. It uses the
engine-neutral `utsushi_core::port::impl_map` schema, whose `Research` /
`Partial` statuses are the honest-scope mechanism (they carry no
broad-compatibility claim; the validator stamps the
`STATUS_VALIDATED_DISCLAIMER`). The subsystems named as follow-ups:

1. **`scene-pck-bytecode-decode`** — decode real `Scene.pck` scene bytecode into
   a typed op stream (Research; anchored on siglus-decompile + Kaifuu Siglus
   format work).
2. **`siglus-opcode-dispatch`** — the real Siglus opcode table + stack/register
   interpreter (Research). The synthetic `SiglusTraceOp` set is explicitly a
   stand-in, not this.
3. **`siglus-string-table-utf16`** — resolve UTF-16LE scene strings + engine
   text substitution into `TextLine`s (Research).
4. **`gameexe-namespace-resolution`** — resolve `Gameexe.dat` namespaced config
   into runtime state (Research).
5. **`siglus-lzss-decompression`** — the proprietary Siglus LZSS container codec
   the UTSUSHI-035 boundary currently rejects as out-of-profile (Research).
6. **`siglus-flag-and-variable-banks`** — the real flag/variable bank model and
   its snapshot/restore mapping (Research; the smoke models a synthetic subset).
7. **`siglus-selbtn-choices`** — Siglus choice/selection (`SelBtn`-style)
   dispatch feeding the choice-translation surface (Research).

The single subsystem this smoke actually exercises —
**`synthetic-text-trace-vm-smoke`** — is recorded as `Partial` with explicit
limitations (synthetic opcode set, no real bytecode), so the map never claims
the VM subsystem is supported.

## 5. Provenance summary line (grep-pinnable)

> siglus_rs (xmoezzz, MPL-2.0) and siglus-decompile (bluecookies, no-license →
> all-rights-reserved) were studied as research anchors only. utsushi-siglus-vm
> vendors none of them, links none of them, and mechanically translates none of
> them; the VM's opcode set and key handling are authored synthetic. Real
> Siglus VM subsystems are named as Research follow-ups, not implemented.
