use super::*;

/// How a `TEXT.DAT` pointer landed relative to the record pool.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status", content = "text")]
pub enum PointerResolution {
    /// The pointer equals an exact record boundary; carries the decoded line.
    Resolved(String),
    /// The pointer falls *within* the pool byte range but does **not** land on a
    /// record boundary — a genuine dangling pointer (the proof-bar violation).
    Dangling,
    /// The pointer lies outside the record pool entirely, so it is not a
    /// `TEXT.DAT` text reference — e.g. a system/branch SELECT immediate such as
    /// `0x40000000`. Not a failure: the command simply carries no inline text.
    OutOfPool,
}

/// A single `TEXT.DAT` pointer: its value, the absolute byte offset of its
/// 4-byte field within `SCRIPT.SRC` (for patch-back), and how it resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextRef {
    /// The pointer value: an absolute byte offset into the decrypted `TEXT.DAT`
    /// record pool.
    pub pointer: u32,
    /// Absolute byte offset of this pointer's 4-byte field within `SCRIPT.SRC`.
    pub field_offset: usize,
    /// How the pointer resolved against the record pool.
    pub resolution: PointerResolution,
}

impl TextRef {
    /// The decoded line if this pointer landed on an exact record boundary.
    #[must_use]
    pub fn resolved_text(&self) -> Option<&str> {
        match &self.resolution {
            PointerResolution::Resolved(t) => Some(t.as_str()),
            _ => None,
        }
    }

    /// Whether this pointer landed on an exact `TEXT.DAT` record boundary.
    #[must_use]
    pub fn is_resolved(&self) -> bool {
        matches!(self.resolution, PointerResolution::Resolved(_))
    }

    /// Whether this pointer fell inside the pool but missed a boundary (a
    /// genuine dangling pointer — the integrity failure the proof bar forbids).
    #[must_use]
    pub fn is_dangling(&self) -> bool {
        matches!(self.resolution, PointerResolution::Dangling)
    }

    /// Whether this pointer lies outside the record pool (a non-text reference,
    /// e.g. a system/branch SELECT immediate).
    #[must_use]
    pub fn is_out_of_pool(&self) -> bool {
        matches!(self.resolution, PointerResolution::OutOfPool)
    }
}

/// One dialogue line recovered from a TEXT-SHOW command, in play order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DialogueUnit {
    /// Absolute byte offset of the 32-byte command in `SCRIPT.SRC`.
    pub command_offset: usize,
    /// The dialogue text pointer + resolution.
    pub text: TextRef,
    /// The speaker name pointer + resolution, or `None` for narration
    /// (name pointer == [`NO_SPEAKER_POINTER`]).
    pub speaker: Option<TextRef>,
}

/// One choice line recovered from a SELECT command, in play order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChoiceUnit {
    /// Absolute byte offset of the 16-byte command in `SCRIPT.SRC`.
    pub command_offset: usize,
    /// The choice text pointer + resolution.
    pub text: TextRef,
}

/// The resolved dialogue + speaker + choice stream for one `SCRIPT.SRC`, in play
/// order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Disassembly {
    /// Dialogue lines (TEXT-SHOW), in play order.
    pub dialogue: Vec<DialogueUnit>,
    /// Choice lines (SELECT), in play order.
    pub choices: Vec<ChoiceUnit>,
}

impl Disassembly {
    /// Every pointer in the stream (dialogue text, present speakers, choice
    /// text), for aggregate resolution accounting.
    fn all_refs(&self) -> impl Iterator<Item = &TextRef> {
        self.dialogue
            .iter()
            .flat_map(|d| std::iter::once(&d.text).chain(d.speaker.as_ref()))
            .chain(self.choices.iter().map(|c| &c.text))
    }

    /// Total count of **dangling** pointers across the whole stream — pointers
    /// that fall inside the pool yet miss a record boundary. This is the
    /// integrity bar: it must be **0** (an out-of-pool system-select immediate is
    /// *not* dangling and is not counted).
    #[must_use]
    pub fn dangling_pointer_count(&self) -> usize {
        self.all_refs().filter(|r| r.is_dangling()).count()
    }

    /// Count of dialogue **text** pointers that did not resolve to a record
    /// boundary (dangling *or* out-of-pool). A dialogue line must always carry
    /// resolvable inline text, so on real bytes this is 0.
    #[must_use]
    pub fn unresolved_dialogue_text_count(&self) -> usize {
        self.dialogue
            .iter()
            .filter(|d| !d.text.is_resolved())
            .count()
    }

    /// Count of present speaker **name** pointers that did not resolve (narration
    /// lines carry no name pointer and are not counted). On real bytes this is 0.
    #[must_use]
    pub fn unresolved_speaker_count(&self) -> usize {
        self.dialogue
            .iter()
            .filter_map(|d| d.speaker.as_ref())
            .filter(|s| !s.is_resolved())
            .count()
    }

    /// Count of SELECT commands whose label resolves to a record boundary —
    /// i.e. genuine **text-bearing** choices.
    #[must_use]
    pub fn text_bearing_choice_count(&self) -> usize {
        self.choices.iter().filter(|c| c.text.is_resolved()).count()
    }

    /// Count of SELECT commands whose label lies outside the pool — non-text
    /// **system / branch** selects (for example, typed `0x40000000`).
    #[must_use]
    pub fn nontext_select_count(&self) -> usize {
        self.choices
            .iter()
            .filter(|c| c.text.is_out_of_pool())
            .count()
    }

    /// The 100 % proof bar: **zero** dangling pointers anywhere, every dialogue
    /// text pointer resolved, and every present speaker name pointer resolved.
    /// (Out-of-pool system-select immediates are permitted and disclosed
    /// separately via [`Self::nontext_select_count`].)
    #[must_use]
    pub fn is_fully_resolved(&self) -> bool {
        self.dangling_pointer_count() == 0
            && self.unresolved_dialogue_text_count() == 0
            && self.unresolved_speaker_count() == 0
    }
}
