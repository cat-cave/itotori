use corpus_registry::{Need, resolve};

#[test]
fn staged_registry_resolves_each_declared_corpus() {
    let needs = [
        Need {
            engine: "reallive",
            ordinal: 1,
            variant: "encrypted",
        },
        Need {
            engine: "reallive",
            ordinal: 2,
            variant: "plain",
        },
        Need {
            engine: "siglus",
            ordinal: 1,
            variant: "encrypted",
        },
        Need {
            engine: "siglus",
            ordinal: 2,
            variant: "encrypted",
        },
        Need {
            engine: "softpal",
            ordinal: 1,
            variant: "plain",
        },
        Need {
            engine: "softpal",
            ordinal: 2,
            variant: "plain",
        },
    ];
    let mut resolved = 0;

    for need in needs {
        let path =
            resolve(need).unwrap_or_else(|reason| panic!("registry must resolve {need}: {reason}"));
        assert!(path.is_dir(), "resolved corpus path is a directory");
        resolved += 1;
    }

    assert_eq!(
        resolved,
        needs.len(),
        "every declared staged corpus resolves"
    );
}
