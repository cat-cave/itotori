//! Hand-rolled JSON Schema (Draft 2020-12) emitter for the implementation
//! map. The Rust types in [`super::schema`] are the source of truth; this
//! module emits a parity document validated by [`super::tests`] and by the
//! external `roadmap/impl-map.schema.json` artifact (committed alongside
//! this crate; checked at `just check` time).

use serde_json::{Value, json};

/// Build the JSON Schema document. Stable, deterministic — repeated calls
/// produce identical bytes (after `serde_json::to_string_pretty`).
pub fn build_schema() -> Value {
    let definitions = json!({
        "PortId": { "type": "string", "minLength": 8, "maxLength": 64, "pattern": "^[a-z][a-z0-9-]{7,63}$" },
        "SubsystemId": { "type": "string", "minLength": 1, "pattern": "^[a-z0-9-]+$" },
        "ValidationCommandId": { "type": "string", "minLength": 1, "pattern": "^[a-z0-9-]+$" },
        "EngineFamily": {
            "type": "string",
            "enum": [
                "reallive", "rpgmaker-mv", "rpgmaker-mz", "rpgmaker-vx-ace",
                "kirikiri-kag", "xp3", "siglus", "renpy", "wolf-rpg-editor",
                "bgi-ethornell", "tyranoscript", "rgss3", "unity", "other"
            ]
        },
        "Status": { "type": "string", "enum": ["Draft", "Validated", "Outdated"] },
        "FixtureClassification": {
            "type": "string",
            "enum": ["Public", "PrivateLocal", "SyntheticInline"]
        },
        "FixtureKind": {
            "type": "string",
            "enum": ["File", "Directory", "Archive", "SyntheticInline", "Other"]
        },
        "EvidenceKind": {
            "type": "string",
            "enum": ["Fixture", "Doc", "RoadmapNode", "ReferenceImplAnchor"]
        },
        "CaptureMethod": {
            "type": "string",
            "enum": [
                "TraceLog", "ScreenshotArtifact", "AudioEvent",
                "SnapshotState", "SyntheticSelfCheck", "NoReferenceComparison"
            ]
        },
        "FixtureRef": {
            "type": "object",
            "required": ["id", "classification", "kind", "hash", "byteCount"],
            "additionalProperties": false,
            "properties": {
                "id": { "type": "string", "minLength": 1 },
                "classification": { "$ref": "#/$defs/FixtureClassification" },
                "kind": { "$ref": "#/$defs/FixtureKind" },
                "kindNotes": { "type": "string" },
                "hash": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
                "byteCount": { "type": "integer", "minimum": 0 }
            }
        },
        "EvidenceRef": {
            "type": "object",
            "required": ["kind", "locator", "caption"],
            "additionalProperties": false,
            "properties": {
                "kind": { "$ref": "#/$defs/EvidenceKind" },
                "locator": { "type": "string", "minLength": 1 },
                "caption": { "type": "string", "minLength": 1 }
            }
        },
        "UnsupportedReason": {
            "type": "object",
            "required": ["kind", "data"],
            "additionalProperties": false,
            "properties": {
                "kind": { "type": "string", "enum": ["SemanticCode", "DeferredTo"] },
                "data": { "type": "string", "minLength": 1 }
            }
        },
        "SubsystemStatus": {
            "type": "object",
            "required": ["kind"],
            "properties": {
                "kind": {
                    "type": "string",
                    "enum": ["Supported", "Partial", "Unsupported", "Research"]
                },
                "data": {}
            },
            "allOf": [
                {
                    "if": { "properties": { "kind": { "const": "Partial" } } },
                    "then": {
                        "required": ["data"],
                        "properties": {
                            "data": {
                                "type": "object",
                                "required": ["limitations"],
                                "properties": {
                                    "limitations": {
                                        "type": "array",
                                        "minItems": 1,
                                        "items": { "type": "string", "minLength": 1 }
                                    }
                                }
                            }
                        }
                    }
                },
                {
                    "if": { "properties": { "kind": { "const": "Unsupported" } } },
                    "then": {
                        "required": ["data"],
                        "properties": {
                            "data": {
                                "type": "object",
                                "required": ["reason"],
                                "properties": {
                                    "reason": { "$ref": "#/$defs/UnsupportedReason" }
                                }
                            }
                        }
                    }
                },
                {
                    "if": { "properties": { "kind": { "const": "Research" } } },
                    "then": {
                        "required": ["data"],
                        "properties": {
                            "data": {
                                "type": "object",
                                "required": ["evidenceRefs"],
                                "properties": {
                                    "evidenceRefs": {
                                        "type": "array",
                                        "minItems": 1,
                                        "items": { "$ref": "#/$defs/EvidenceRef" }
                                    }
                                }
                            }
                        }
                    }
                }
            ]
        },
        "Subsystem": {
            "type": "object",
            "required": [
                "id", "name", "status", "fixtureRef",
                "validationCommandId", "capabilities"
            ],
            "additionalProperties": false,
            "properties": {
                "id": { "$ref": "#/$defs/SubsystemId" },
                "name": { "type": "string", "minLength": 1 },
                "status": { "$ref": "#/$defs/SubsystemStatus" },
                "fixtureRef": { "$ref": "#/$defs/FixtureRef" },
                "validationCommandId": { "$ref": "#/$defs/ValidationCommandId" },
                "capabilities": {
                    "type": "array",
                    "minItems": 1,
                    "items": { "type": "string", "minLength": 1 }
                },
                "notes": { "type": "string" }
            }
        },
        "ExpectedOutcome": {
            "type": "object",
            "required": ["kind"],
            "properties": {
                "kind": { "type": "string", "enum": ["Pass", "Skip", "Fail"] },
                "data": {}
            }
        },
        "ValidationCommand": {
            "type": "object",
            "required": ["id", "command", "expectedOutcome", "caption"],
            "additionalProperties": false,
            "properties": {
                "id": { "$ref": "#/$defs/ValidationCommandId" },
                "command": { "type": "string", "minLength": 1 },
                "expectedOutcome": { "$ref": "#/$defs/ExpectedOutcome" },
                "caption": { "type": "string", "minLength": 1 }
            }
        },
        "ReferenceBehavior": {
            "type": "object",
            "required": ["engineRuntime", "observableSignal", "captureMethod"],
            "additionalProperties": false,
            "properties": {
                "engineRuntime": { "type": "string", "minLength": 1 },
                "observableSignal": { "type": "string", "minLength": 1 },
                "captureMethod": { "$ref": "#/$defs/CaptureMethod" }
            }
        }
    });

    json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://itotori.dev/schemas/utsushi/impl-map.schema.json",
        "title": "Utsushi engine-port implementation map (UTSUSHI-025)",
        "type": "object",
        "required": [
            "schemaVersion", "portId", "engineFamily", "subsystems",
            "validationCommands", "referenceBehavior", "status", "generatedAt"
        ],
        "additionalProperties": false,
        "properties": {
            "schemaVersion": { "type": "string", "pattern": "^0\\.\\d+\\.\\d+$" },
            "portId": { "$ref": "#/$defs/PortId" },
            "engineFamily": { "$ref": "#/$defs/EngineFamily" },
            "engineFamilyNotes": { "type": "string", "minLength": 1 },
            "subsystems": {
                "type": "array",
                "minItems": 1,
                "items": { "$ref": "#/$defs/Subsystem" }
            },
            "validationCommands": {
                "type": "array",
                "minItems": 1,
                "items": { "$ref": "#/$defs/ValidationCommand" }
            },
            "referenceBehavior": { "$ref": "#/$defs/ReferenceBehavior" },
            "status": { "$ref": "#/$defs/Status" },
            "statusDisclaimer": { "type": "string" },
            "generatedAt": { "type": "string", "minLength": 20 }
        },
        "allOf": [
            {
                "if": {
                    "required": ["engineFamily"],
                    "properties": { "engineFamily": { "const": "other" } }
                },
                "then": { "required": ["engineFamilyNotes"] }
            }
        ],
        "$defs": definitions
    })
}
