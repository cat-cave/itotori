use super::*;

fn is_reallive_secondary_release(code: &RawInputCode) -> bool {
    code.engine == REALLIVE_RAW_INPUT_ENGINE && code.code == REALLIVE_RAW_SECONDARY_RELEASE
}

impl LongOpScheduler for BridgeScheduler {
    fn poll(&mut self, head: &mut LongOp) -> LongOpReadiness {
        let pending = PendingYield::classify(head);
        while let Some(event) = self.source.next_event(pending) {
            self.capture(event.clone());
            match event {
                // Navigation: move the highlighted option; do not commit.
                InputEvent::Pointer { .. } => {
                    self.nav_events = self.nav_events.saturating_add(1);
                }
                InputEvent::MenuSelect { target } => {
                    if let Ok(index) = target.item_id.trim().parse::<u16>() {
                        self.nav_cursor = index;
                    }
                    self.nav_events = self.nav_events.saturating_add(1);
                }
                // Explicit choice commit.
                InputEvent::Choice { index, .. } => {
                    self.nav_cursor = index.get();
                    self.commit(head, pending, Some(index.get()));
                    return LongOpReadiness::Ready;
                }
                // Text-advance / click-to-advance: dismiss a pause, or commit
                // the currently-highlighted choice on a select gate.
                InputEvent::Text {} | InputEvent::Advance {} => {
                    self.commit(head, pending, None);
                    return LongOpReadiness::Ready;
                }
                InputEvent::Raw { code } if is_reallive_secondary_release(&code) => {
                    if self.cancel_object_select(head, pending) {
                        return LongOpReadiness::Ready;
                    }
                }
                // Non-gate toggles / state requests: recorded, no commit.
                InputEvent::Skip { .. }
                | InputEvent::Auto { .. }
                | InputEvent::Save { .. }
                | InputEvent::Load { .. }
                | InputEvent::Raw { .. } => {}
            }
        }
        LongOpReadiness::Pending
    }
}
