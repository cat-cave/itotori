use utsushi_fixture::corpus_registry::{Need, Unavailable, resolve, skip};

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
    let first = needs[0];
    if let Err(reason) = resolve(first) {
        if matches!(reason, Unavailable::RootUnset) {
            skip("staged_registry_resolves_each_declared_corpus", reason);
            return;
        }
        panic!("registry must resolve its first declared corpus: {reason}");
    }

    let mut resolved = 0;

    for need in needs {
        match resolve(need) {
            Ok(path) => {
                assert!(path.is_dir(), "resolved corpus path is a directory");
                resolved += 1;
            }
            Err(reason) => skip("staged_registry_resolves_each_declared_corpus", reason),
        }
    }

    assert_eq!(
        resolved,
        needs.len(),
        "every declared staged corpus resolves"
    );
}
