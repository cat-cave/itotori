//! Launch hydration through the request VFS.
//!
//! The synthetic case deliberately gives the port an input root that does not
//! contain the assets. Launch can therefore succeed only by consuming the
//! mounted substrate VFS. The real-byte case is optional and exercises two
//! externally supplied installations without serializing their content.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use kaifuu_siglus::{SCENE_PCK_HEADER_BYTE_LEN, apply_gameexe_xor_table, apply_xor_table};
use tempfile::TempDir;
use utsushi_core::RuntimeOperation;
use utsushi_core::substrate::{EnginePort, PortRequest, RuntimeVfs};
use utsushi_core::{CaseRule, MountedVfs, PackageSource, PlaintextDirPackage};
use utsushi_siglus::UtsushiSiglusPort;

const FIRST_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS";
const SECOND_TITLE_ENV: &str = "ITOTORI_REAL_GAME_ROOT_SIGLUS_2";

#[test]
fn launch_hydrates_the_asset_package_from_request_vfs_and_indexes_scenes() {
    let temp = TempDir::new().expect("temporary fixture directory");
    let mounted_root = temp.path().join("mounted-assets");
    fs::create_dir_all(&mounted_root).expect("fixture asset directory");
    fs::write(
        mounted_root.join("Scene.pck"),
        synthetic_scene_pack(&[b"first", b"second"]),
    )
    .expect("write synthetic scene package");
    fs::write(
        mounted_root.join("Gameexe.dat"),
        synthetic_gameexe("#ENTRY.000=1\r\n#ENTRY.001=2\r\n"),
    )
    .expect("write synthetic configuration");

    let vfs = mounted_vfs(&mounted_root, "synthetic-siglus-launch");
    // This path has no assets. A host-filesystem launch implementation would
    // fail here; the assets are reachable only through `request.vfs`.
    let unmounted_input = temp.path().join("not-mounted-into-the-vfs");
    let request = PortRequest::new(
        &unmounted_input,
        "siglus-vfs-launch",
        RuntimeOperation::Trace,
    )
    .with_vfs(vfs);
    let mut port = UtsushiSiglusPort::new();

    port.launch(&request)
        .expect("launch decodes containers through the request VFS");

    assert!(port.context().asset_package().is_some());
    assert_eq!(port.scene_count(), 2);
    assert_eq!(port.moment_count(), 2);
    assert_eq!(port.gameexe_entry_count(), 2);
    let index = port.scene_moment_index().expect("launch index");
    assert_eq!(index.moments()[0].id.value, "siglus:scene-0000");
    assert_eq!(index.moments()[1].id.value, "siglus:scene-0001");
    assert_eq!(index.moments()[0].decoded_byte_len, b"first".len());
    assert_eq!(index.moments()[1].decoded_byte_len, b"second".len());
}

#[test]
fn two_real_siglus_titles_launch_through_vfs_when_available() {
    let Some(first) = corpus_root(FIRST_TITLE_ENV) else {
        return;
    };
    let Some(second) = corpus_root(SECOND_TITLE_ENV) else {
        return;
    };

    let mut scene_counts = [
        exercise_real_title(&first, "siglus-title-one"),
        exercise_real_title(&second, "siglus-title-two"),
    ];
    scene_counts.sort_unstable();
    assert_eq!(scene_counts, [278, 298]);
}

fn corpus_root(variable: &str) -> Option<PathBuf> {
    let Some(value) = std::env::var_os(variable) else {
        eprintln!("SKIP Siglus launch real bytes: {variable} is unset");
        return None;
    };
    let candidate = PathBuf::from(value);
    let root = if candidate.is_dir() {
        candidate
    } else {
        candidate.parent().map(Path::to_path_buf)?
    };
    for logical in ["Scene.pck", "Gameexe.dat", "SiglusEngine.exe"] {
        if !root.join(logical).is_file() {
            eprintln!("SKIP Siglus launch real bytes: {variable} lacks required assets");
            return None;
        }
    }
    Some(root)
}

fn exercise_real_title(root: &Path, package_id: &str) -> usize {
    let vfs = mounted_vfs(root, package_id);
    // The port must not consult this host path; all three required assets are
    // resolved from the package above.
    let request = PortRequest::new(
        Path::new("siglus-launch-input-is-vfs-only"),
        package_id,
        RuntimeOperation::Trace,
    )
    .with_vfs(vfs);
    let mut port = UtsushiSiglusPort::new();
    port.launch(&request)
        .expect("real Siglus launch hydration succeeds through VFS");
    assert_eq!(port.scene_count(), port.moment_count());
    assert!(port.gameexe_entry_count() > 0);
    assert!(port.context().asset_package().is_some());
    port.scene_count()
}

fn mounted_vfs(root: &Path, package_id: &str) -> Arc<dyn RuntimeVfs> {
    let package = PlaintextDirPackage::new(
        package_id,
        root,
        CaseRule::InsensitiveAscii,
        PackageSource::PublicName(format!("fixture:{package_id}")),
    );
    let mut vfs = MountedVfs::new(
        package_id,
        PackageSource::PublicName(format!("fixture:{package_id}")),
    );
    vfs.mount_plaintext_dir(package);
    Arc::new(vfs)
}

fn synthetic_scene_pack(payloads: &[&[u8]]) -> Vec<u8> {
    let chunks: Vec<Vec<u8>> = payloads
        .iter()
        .map(|payload| masked_chunk(payload))
        .collect();
    let names: Vec<String> = (0..chunks.len())
        .map(|index| format!("scene-{index:04}"))
        .collect();
    let name_index_ofs = SCENE_PCK_HEADER_BYTE_LEN;
    let name_list_ofs = name_index_ofs + chunks.len() * 8;
    let name_bytes: Vec<u8> = names
        .iter()
        .flat_map(|name| name.encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    let data_index_ofs = name_list_ofs + name_bytes.len();
    let data_list_ofs = data_index_ofs + chunks.len() * 8;
    let data_len: usize = chunks.iter().map(Vec::len).sum();
    let mut archive = vec![0u8; data_list_ofs + data_len];

    put_header_field(&mut archive, 0, SCENE_PCK_HEADER_BYTE_LEN as u32);
    put_header_field(&mut archive, 13, name_index_ofs as u32);
    put_header_field(&mut archive, 14, chunks.len() as u32);
    put_header_field(&mut archive, 15, name_list_ofs as u32);
    put_header_field(&mut archive, 16, chunks.len() as u32);
    put_header_field(&mut archive, 17, data_index_ofs as u32);
    put_header_field(&mut archive, 18, chunks.len() as u32);
    put_header_field(&mut archive, 19, data_list_ofs as u32);
    put_header_field(&mut archive, 20, chunks.len() as u32);

    let mut name_char_offset = 0u32;
    let mut data_offset = 0usize;
    for (index, (name, chunk)) in names.iter().zip(&chunks).enumerate() {
        let name_pair = name_index_ofs + index * 8;
        archive[name_pair..name_pair + 4].copy_from_slice(&name_char_offset.to_le_bytes());
        archive[name_pair + 4..name_pair + 8]
            .copy_from_slice(&(name.encode_utf16().count() as u32).to_le_bytes());
        name_char_offset += name.encode_utf16().count() as u32;

        let data_pair = data_index_ofs + index * 8;
        archive[data_pair..data_pair + 4].copy_from_slice(&(data_offset as u32).to_le_bytes());
        archive[data_pair + 4..data_pair + 8].copy_from_slice(&(chunk.len() as u32).to_le_bytes());
        let start = data_list_ofs + data_offset;
        archive[start..start + chunk.len()].copy_from_slice(chunk);
        data_offset += chunk.len();
    }
    archive[name_list_ofs..data_index_ofs].copy_from_slice(&name_bytes);
    archive
}

fn masked_chunk(payload: &[u8]) -> Vec<u8> {
    let compressed = lzss_literals(payload);
    let mut chunk = Vec::with_capacity(compressed.len() + 8);
    chunk.extend_from_slice(&((compressed.len() + 8) as u32).to_le_bytes());
    chunk.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    chunk.extend_from_slice(&compressed);
    apply_xor_table(&chunk, None)
}

fn synthetic_gameexe(ini: &str) -> Vec<u8> {
    let plaintext: Vec<u8> = ini.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let compressed = lzss_literals(&plaintext);
    let mut body = Vec::with_capacity(compressed.len() + 8);
    body.extend_from_slice(&((compressed.len() + 8) as u32).to_le_bytes());
    body.extend_from_slice(&(plaintext.len() as u32).to_le_bytes());
    body.extend_from_slice(&compressed);
    let mut container = vec![0u8; 8]; // version=0, exe_angou_mode=0
    container.extend_from_slice(&apply_gameexe_xor_table(&body, None));
    container
}

fn lzss_literals(bytes: &[u8]) -> Vec<u8> {
    let mut stream = Vec::new();
    for group in bytes.chunks(8) {
        let flags = if group.len() == 8 {
            u8::MAX
        } else {
            ((1u16 << group.len()) - 1) as u8
        };
        stream.push(flags);
        stream.extend_from_slice(group);
    }
    stream
}

fn put_header_field(bytes: &mut [u8], field: usize, value: u32) {
    let offset = field * 4;
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}
