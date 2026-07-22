use super::*;

// Manifest access.

pub(super) fn manifest_value() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/synthetic/coverage-manifest.v0.json");
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|err| panic!("read coverage manifest {}: {err}", path.display()));
    serde_json::from_slice(&bytes).expect("coverage manifest is valid JSON")
}

pub(super) fn reallive_group<'a>(manifest: &'a Value, group: &str) -> &'a Value {
    &manifest["engineFamilies"]["reallive"]["componentGroups"][group]
}

/// The 289 `(module_id, opcode)` tuples the manifest enumerates for RealLive.
pub(super) fn manifest_tuples(manifest: &Value) -> Vec<(u8, u16)> {
    reallive_group(manifest, "opcode_tuple")["components"]
        .as_array()
        .expect("opcode_tuple components array")
        .iter()
        .map(|c| {
            (
                c["moduleId"].as_u64().expect("moduleId") as u8,
                c["opcode"].as_u64().expect("opcode") as u16,
            )
        })
        .collect()
}

pub(super) fn manifest_string_list(manifest: &Value, group: &str) -> Vec<String> {
    reallive_group(manifest, group)["components"]
        .as_array()
        .expect("components array")
        .iter()
        .map(|c| c.as_str().expect("string component").to_string())
        .collect()
}

// Synthetic RealLive archive builder — built FROM the real encoders.

/// A planted 16-byte `xor_2` key used to STAGE the encrypted-at-rest xor2
/// corpus. Recovery is done by the REAL cross-scene known-plaintext recovery
/// ([`recover_and_decrypt_archive`]); this only encrypts the fixture so the
/// real recovery has something to recover. Non-copyrighted, arbitrary bytes.
const PLANTED_XOR2_KEY: [u8; 16] = [
    0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x01,
];

const XOR2_SEGMENT_OFFSET: usize = 0x100; // 256
const XOR2_SEGMENT_LENGTH: usize = 0x101; // 257

/// The documented `xor_2` segment transform (`data[256 + i] ^= key[i % 16]`).
/// Self-inverse; used ONLY to stage the encrypted fixture. The real decryptor
/// is [`recover_and_decrypt_archive`].
fn stage_encrypt_xor2_segment(data: &mut [u8], key: &[u8; 16]) {
    for i in 0..XOR2_SEGMENT_LENGTH {
        let pos = XOR2_SEGMENT_OFFSET + i;
        if pos >= data.len() {
            break;
        }
        data[pos] ^= key[i % 16];
    }
}

fn push_cmd(out: &mut Vec<u8>, module_type: u8, module_id: u8, opcode: u16) {
    out.push(0x23); // COMMAND opener
    out.push(module_type);
    out.push(module_id);
    out.extend_from_slice(&opcode.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // argc = 0
    out.push(0); // overload
}

fn push_meta_line(out: &mut Vec<u8>, line: u16) {
    out.push(0x0a);
    out.extend_from_slice(&line.to_le_bytes());
}

/// The synthetic English dialogue line (ASCII => a valid Shift-JIS Textout run
/// carrying no structural opener bytes and no control bytes, so the bridge
/// surfaces it as a translatable `dialogue` unit).
const SYNTH_DIALOGUE: &[u8] = b"[EN] Hello traveler this is a synthetic line";

/// The two synthetic English source choice options (plain NextString tokens —
/// letters + spaces only, so they decode cleanly through the real select
/// framing).
const SYNTH_CHOICE_0: &[u8] = b"Left path onward";
const SYNTH_CHOICE_1: &[u8] = b"Right path homeward";

/// Build the decompressed scene bytecode that instantiates every RealLive
/// element form + every manifest `(module_id, opcode)` tuple exactly once.
///
/// Layout: `pad` MetaLine(0) triples (so the `xor_2` segment `[256, 513)` is
/// uniform across scenes and the real known-plaintext key recovery is exact)
/// then the feature-complete body.
fn build_content_bytecode(tuples: &[(u8, u16)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();

    // 0x00 dominant padding so the xor_2 [256,513) segment is a uniform
    // MetaLine(0) run in every eligible scene (exact key recovery).
    for _ in 0..200 {
        push_meta_line(&mut out, 0); // 0a 00 00
    }

    push_meta_line(&mut out, 1); // MetaLine
    out.extend_from_slice(&[0x21, 0x00, 0x00]); // MetaEntrypoint
    out.extend_from_slice(&[0x40, 0x00, 0x00]); // MetaKidoku
    out.push(0x00); // Comma (0x00 form)
    out.push(0x2c); // Comma (0x2C form)
    out.extend_from_slice(SYNTH_DIALOGUE); // Textout (dialogue run)
    // NB: the standalone `0x24` Expression element form is a kaifuu decoder
    // taxonomy element whose utsushi counterpart is an ASSIGNMENT-shaped
    // element; it is covered (and 0x24-opener coverage with it) via the
    // kaifuu-decoded corpus snippets in `decoder_snippets`, kept OUT of the
    // archived scene so utsushi's independent decoder reaches clean parity.

    push_cmd(&mut out, 1, 3, 3); //  CharacterTextDisplay (msg opcode 3)
    push_cmd(&mut out, 1, 4, 17); // End (sys opcode 17)
    push_cmd(&mut out, 1, 11, 0); // SetVariable (mem)
    push_cmd(&mut out, 1, 1, 0); //  Goto (jmp 0/1)
    push_cmd(&mut out, 1, 1, 2); //  Branch (jmp 2/3)
    push_cmd(&mut out, 1, 1, 4); //  If (jmp 4/5)
    push_cmd(&mut out, 1, 1, 10); // Call (jmp 10..=13)
    push_cmd(&mut out, 1, 1, 20); // Return (jmp 20..=22)
    push_cmd(&mut out, 1, 1, 30); // Jump (jmp default)

    push_select_block(&mut out, &[SYNTH_CHOICE_0, SYNTH_CHOICE_1]);

    // module_type 1 keeps every tuple on the ordinary function-call framing
    // (no select/goto special-casing), so each is exactly an 8-byte header the
    // classifier maps to a recognised semantic family.
    for &(module_id, opcode) in tuples {
        push_cmd(&mut out, 1, module_id, opcode);
    }

    push_meta_line(&mut out, 0); // final MetaLine terminator
    out
}

/// Append a `module_sel` select block (`0x23` header, `{`, options, `}`) using
/// the real select-block framing.
fn push_select_block(out: &mut Vec<u8>, options: &[&[u8]]) {
    push_cmd(out, 0, 2, 0); // module_type 0, module 2, opcode 0 => select
    out.push(b'{');
    for (i, opt) in options.iter().enumerate() {
        out.extend_from_slice(opt);
        // trailing `\n` + i16 line marker for this option
        push_meta_line(out, (i + 1) as u16);
    }
    out.push(b'}');
}

/// The `0x1d0`-byte scene header with the documented field offsets. Built by
/// hand exactly as the real encoder lays it out; both the kaifuu and utsushi
/// header decoders parse it.
fn build_scene_header(compiler_version: u32, uncompressed: u32, compressed: u32) -> Vec<u8> {
    let mut h = vec![0u8; kaifuu_reallive::SCENE_HEADER_BYTE_LEN];
    let put = |h: &mut [u8], off: usize, v: u32| h[off..off + 4].copy_from_slice(&v.to_le_bytes());
    put(&mut h, 0x00, kaifuu_reallive::SCENE_HEADER_BYTE_LEN as u32); // header_size
    put(&mut h, 0x04, compiler_version);
    put(&mut h, 0x08, kaifuu_reallive::SCENE_HEADER_BYTE_LEN as u32); // kidoku_offset
    put(&mut h, 0x0c, 0); // kidoku_count
    put(&mut h, 0x20, kaifuu_reallive::SCENE_HEADER_BYTE_LEN as u32); // bytecode_offset
    put(&mut h, 0x24, uncompressed);
    put(&mut h, 0x28, compressed);
    h
}

/// Assemble one scene payload (`header || avg32-compressed bytecode`) from a
/// plaintext (or already-`xor_2`-encrypted) decompressed bytecode.
fn build_scene_payload(compiler_version: u32, decompressed: &[u8]) -> Vec<u8> {
    let compressed =
        kaifuu_reallive::compress_avg32_literal(decompressed).expect("AVG32 re-compress");
    let header = build_scene_header(
        compiler_version,
        decompressed.len() as u32,
        compressed.len() as u32,
    );
    let mut payload = header;
    payload.extend_from_slice(&compressed);
    payload
}

/// Pack a set of `(slot_id, payload)` scenes into a real 10,000-slot `Seen.txt`
/// envelope.
fn pack_seen_txt(scenes: &[(u16, Vec<u8>)]) -> Vec<u8> {
    let directory_len = kaifuu_reallive::REALLIVE_SEEN_TXT_DIRECTORY_BYTE_LEN as usize;
    let mut directory = vec![0u8; directory_len];
    let mut body: Vec<u8> = Vec::new();
    for (slot_id, payload) in scenes {
        let offset = directory_len + body.len();
        let slot = (*slot_id as usize) * 8;
        directory[slot..slot + 4].copy_from_slice(&(offset as u32).to_le_bytes());
        directory[slot + 4..slot + 8].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        body.extend_from_slice(payload);
    }
    let mut seen = directory;
    seen.extend_from_slice(&body);
    seen
}

pub(super) struct SyntheticCorpus {
    label: &'static str,
    pub(super) seen_bytes: Vec<u8>,
    /// Slot id of the feature-complete content scene.
    pub(super) content_scene_id: u16,
    /// The plaintext content bytecode (post-`xor_2`-decrypt), for direct
    /// assertions.
    pub(super) content_bytecode: Vec<u8>,
}

/// Build one synthetic RealLive corpus. `xor2` selects the encrypted-at-rest
/// (compiler 110002) variant; otherwise the plaintext (compiler 10002) variant.
pub(super) fn build_corpus(
    label: &'static str,
    tuples: &[(u8, u16)],
    xor2: bool,
) -> SyntheticCorpus {
    let compiler_version = if xor2 { 110002 } else { 10002 };
    let content = build_content_bytecode(tuples);

    // The stored (decompressed-layer) bytecode: for xor2 scenes it is the
    // plaintext with the [256,513) segment encrypted by the planted key.
    let stored_content = if xor2 {
        let mut c = content.clone();
        stage_encrypt_xor2_segment(&mut c, &PLANTED_XOR2_KEY);
        c
    } else {
        content.clone()
    };

    let content_scene_id: u16 = 1000;
    let mut scenes: Vec<(u16, Vec<u8>)> = vec![(
        content_scene_id,
        build_scene_payload(compiler_version, &stored_content),
    )];

    // For the xor2 corpus, add a couple of pure-padding eligible filler scenes
    // so the cross-scene known-plaintext key recovery is over-determined.
    if xor2 {
        let mut pad = Vec::new();
        for _ in 0..220 {
            push_meta_line(&mut pad, 0);
        }
        for (n, slot) in [1001u16, 1002u16].into_iter().enumerate() {
            let mut stored = pad.clone();
            for _ in 0..(n * 4) {
                push_meta_line(&mut stored, 0);
            }
            stage_encrypt_xor2_segment(&mut stored, &PLANTED_XOR2_KEY);
            scenes.push((slot, build_scene_payload(compiler_version, &stored)));
        }
    }

    SyntheticCorpus {
        label,
        seen_bytes: pack_seen_txt(&scenes),
        content_scene_id,
        content_bytecode: content,
    }
}

/// Decompress + (for xor2) recover-and-decrypt every scene of a corpus
/// returning `(scene_id, plaintext_bytecode)` pairs — exactly the staging the
/// real decoder-parity harness performs.
pub(super) fn staged_scenes(corpus: &SyntheticCorpus) -> Vec<(u16, Vec<u8>)> {
    let mut decompressed =
        decompress_all_scenes(&corpus.seen_bytes).expect("decompress synthetic archive");
    let mut xor2: Vec<Xor2DecScene> = decompressed
        .iter()
        .map(|s| Xor2DecScene {
            compiler_version: s.compiler_version,
            bytecode: s.bytecode.clone(),
        })
        .collect();
    let report = recover_and_decrypt_archive(&mut xor2);
    if xor2
        .iter()
        .any(|s| compiler_version_uses_xor2(s.compiler_version))
    {
        assert!(
            report.validated,
            "[{}] xor_2 key recovery must validate on the synthetic encrypted corpus: {report:?}",
            corpus.label
        );
    }
    for (scene, decrypted) in decompressed.iter_mut().zip(xor2) {
        scene.bytecode = decrypted.bytecode;
    }
    decompressed
        .into_iter()
        .map(|s| (s.scene_id, s.bytecode))
        .collect()
}
