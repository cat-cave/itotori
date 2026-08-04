const CORPORA: [(&str, u16, usize); 2] = [
    ("softpal/1/plain", 1, 417),
    ("softpal/2/plain", 2, 160),
];

struct Inputs {
    archive: Vec<u8>,
    csv_pac: Vec<u8>,
    script: Vec<u8>,
    textdat: Vec<u8>,
    points: Vec<u8>,
    mem_dat: Vec<u8>,
}

fn runtime_root(identity: &str, ordinal: u16, expected_pac_count: usize) -> PathBuf {
    let registry_root = corpus_registry::resolve_identity(identity)
        .unwrap_or_else(|reason| panic!("real-bytes proof not established: {identity}: {reason}"));
    assert!(
        registry_root.is_dir(),
        "real-bytes proof not established: {identity} registry root is unavailable"
    );
    let mount = corpus_registry::media_root()
        .unwrap_or_else(|reason| panic!("real-bytes proof not established: {reason}"));
    let root = mount.join(format!("softpal-{ordinal}"));
    assert!(
        root.is_dir(),
        "real-bytes proof not established: staged runtime root for {identity} is unavailable"
    );
    let archive_bytes = fs::read(root.join("data.pac"))
        .unwrap_or_else(|error| panic!("read staged {identity} data.pac: {error}"));
    let archive = PacArchive::parse(&archive_bytes)
        .unwrap_or_else(|error| panic!("parse staged {identity} data.pac: {error}"));
    assert_eq!(
        archive.len(),
        expected_pac_count,
        "staged runtime root must match the registry-selected corpus"
    );
    root
}

fn inputs(root: &Path) -> Inputs {
    let archive_bytes = fs::read(root.join("data.pac"))
        .unwrap_or_else(|error| panic!("read data.pac under {}: {error}", root.display()));
    let archive = PacArchive::parse(&archive_bytes)
        .unwrap_or_else(|error| panic!("parse data.pac under {}: {error}", root.display()));
    let extract = |name| {
        let entry = archive
            .find(name)
            .unwrap_or_else(|| panic!("{name} missing from data.pac under {}", root.display()));
        archive
            .extract(&archive_bytes, entry)
            .unwrap_or_else(|error| panic!("extract {name} under {}: {error}", root.display()))
            .to_vec()
    };
    let script = extract("SCRIPT.SRC");
    let textdat = extract("TEXT.DAT");
    let points = extract("POINT.DAT");
    let mem_dat = extract("MEM.DAT");
    Inputs {
        archive: archive_bytes,
        csv_pac: fs::read(root.join("csv.pac"))
            .unwrap_or_else(|error| panic!("read csv.pac under {}: {error}", root.display())),
        script,
        textdat,
        points,
        mem_dat,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CallContract {
    category: u16,
    function: u16,
    stack_depth: usize,
    destination_tag: Option<u8>,
    return_value: Option<i32>,
    bank_writes: Vec<(u8, u32)>,
}
