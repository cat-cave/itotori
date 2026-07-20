use serde::{Deserialize, Serialize};

/// The `Call` ([`super::SvOpcode::Call`], opcode `0x17`) *category* (target high word)
/// that dispatches the dialogue message subroutine (TEXT-SHOW).
pub const CALL_CATEGORY_TEXT: u16 = 0x0002;

/// The `Call` *category* (target high word) that dispatches the choice/select
/// subroutine.
pub const CALL_CATEGORY_SELECT: u16 = 0x0006;

/// The `Call` *function* (target low word) under [`CALL_CATEGORY_SELECT`] that is
/// a choice/select command.
pub const SELECT_FUNCTION: u16 = 0x0002;

/// The set of `Call` *functions* (target low word) under [`CALL_CATEGORY_TEXT`]
/// that render a dialogue line. Mirrors the disassembler's
/// [`crate::TEXT_SHOW_TYPE_WORDS`].
pub const TEXT_TYPE_FUNCTIONS: [u16; 7] = [0x0002, 0x000f, 0x0010, 0x0011, 0x0012, 0x0013, 0x0014];

/// The dispatch key of a [`super::SvOpcode::Call`] instruction: the engine built-in it
/// invokes, packed into the call's first operand as
/// `category = high word`, `function = low word`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallTarget {
    /// Subroutine category (the operand's high word) — e.g. `0x0002` message,
    /// `0x0003`/`0x0005`/`0x0007`/`0x0011`/`0x0016` graphics/audio/system.
    pub category: u16,
    /// Function within the category (the operand's low word).
    pub function: u16,
}

impl CallTarget {
    /// Decode a `Call`'s first operand raw value into its `(category, function)`
    /// dispatch key.
    #[must_use]
    pub fn from_operand(raw: u32) -> Self {
        CallTarget {
            category: (raw >> 16) as u16,
            function: (raw & 0xffff) as u16,
        }
    }
    /// Whether this target renders a dialogue line (TEXT-SHOW).
    #[must_use]
    pub fn is_text_show(&self) -> bool {
        self.category == CALL_CATEGORY_TEXT && TEXT_TYPE_FUNCTIONS.contains(&self.function)
    }
    /// Whether this target is a choice/select command.
    #[must_use]
    pub fn is_select(&self) -> bool {
        self.category == CALL_CATEGORY_SELECT && self.function == SELECT_FUNCTION
    }

    /// The faithful engine-operation name when the game executable's registered
    /// handler makes that named `Pal.dll` call.
    ///
    /// This is deliberately an `Option`: a target is *not* given a plausible
    /// sounding name merely because it shares a category with one whose handler
    /// has been reversed.  The names below come from the real game's target
    /// registration table followed by the handler's `Pal.dll` import thunk.
    /// `None` therefore means "structurally decoded, semantics not yet proven",
    /// not an unknown bytecode shape.
    #[must_use]
    pub fn semantic_name(&self) -> Option<&'static str> {
        match (self.category, self.function) {
            // The two text surfaces are independently proved by their stack
            // shape and TEXT.DAT-pointer use in ScriptScan.
            (CALL_CATEGORY_TEXT, function) if TEXT_TYPE_FUNCTIONS.contains(&function) => {
                Some("message.show")
            }
            (CALL_CATEGORY_SELECT, SELECT_FUNCTION) => Some("choice.select"),

            // Sprite/render handlers (category 0x0003).
            (0x0003, 0x0009) => Some("sprite.set_center_offset"),
            (0x0003, 0x000c) => Some("sprite.set_option"),
            (0x0003, 0x000f) => Some("sprite.rect_set_pos"),
            (0x0003, 0x0010) => Some("sprite.set_render_mode"),
            (0x0003, 0x0026) => Some("sprite.copy_rgb"),
            (0x0003, 0x0028) => Some("sprite.paint"),
            (0x0003, 0x0033) => Some("sprite.cancel_transition"),
            (0x0003, 0x0036) => Some("sprite.backbuffer_copy"),
            (0x0003, 0x003e) => Some("sprite.box_blur"),
            (0x0003, 0x0040) => Some("sprite.get_pixel"),
            (0x0003, 0x0041) => Some("sprite.set_pixel"),
            (0x0003, 0x0052) => Some("render_list.clear"),
            (0x0003, 0x0054) => Some("render_list.draw"),
            (0x0003, 0x005f) => Some("sprite.stretch_blt"),
            (0x0003, 0x0062) => Some("sprite.apply_alpha_mask"),
            (0x0003, 0x0063) => Some("sprite.displacement_map"),
            (0x0003, 0x006a) => Some("sprite.swirl_blur"),
            (0x0003, 0x006b) => Some("sprite.set_rotate_resolution"),

            // Audio/video handlers.  The split sound categories are retained
            // because their handlers are distinct registrations in the VM.
            (0x0004, 0x0006) | (0x0005, 0x0004 | 0x000e) => Some("sound.set_volume"),
            (0x0004, 0x0009) | (0x0005, 0x0006) => Some("sound.release"),
            (0x0004, 0x000a) => Some("sound.play_fade"),
            (0x0005, 0x0003) => Some("sound.stop"),
            (0x0005, 0x000f) => Some("sound.set_frequency"),
            (0x000b, 0x0000) => Some("video.play"),
            (0x000b, 0x0001) => Some("movie_sprite.play"),
            (0x000b, 0x0007) => Some("movie_sprite.stop"),

            // Button/input handlers.
            (0x0008, 0x0000) => Some("button.create"),
            (0x0008, 0x0001) => Some("button.release"),
            (0x0008, 0x0008) => Some("button.delete"),
            (0x0008, 0x000f) => Some("button.control"),
            (0x0008, 0x0016) => Some("button.set_reaction"),
            (0x0008, 0x0024) => Some("button.set_mode"),
            (0x0008, 0x0026) => Some("button.get_reaction"),
            (0x0017, 0x0000) => Some("input.get_key_ex"),

            // Effects and utility handlers.
            (0x0013, 0x0001) => Some("fx.set"),
            (0x0013, 0x0002) => Some("fx.get_state"),
            (0x0014, 0x0000) => Some("random.next"),
            (0x0016, 0x0000) => Some("effect.execute"),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CallTarget;

    #[test]
    fn call_target_names_are_export_evidence_not_category_guesses() {
        assert_eq!(
            CallTarget {
                category: 0x0003,
                function: 0x0009
            }
            .semantic_name(),
            Some("sprite.set_center_offset")
        );
        assert_eq!(
            CallTarget {
                category: 0x000b,
                function: 0x0000
            }
            .semantic_name(),
            Some("video.play")
        );
        // Category alone is not evidence: unknown function ids remain named
        // only by their raw dispatch target for a future RE pass.
        assert_eq!(
            CallTarget {
                category: 0x0003,
                function: 0x0001
            }
            .semantic_name(),
            None
        );
    }
}
