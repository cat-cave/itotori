//! Launcher-native scheduler layout recovered from the embedded runtime.
//!
//! The `0x0011:0x001c` handler at `0x0041_bae0` starts its sixteen-group
//! walk at `context + 0x59678`, advances a group by `0x85e4c`, and advances
//! each of its sixty scheduler slots by `0x23a8`.  A slot holds a work table;
//! its elements are `0x4c` bytes and select callbacks through their dword at
//! offset `0x40`.  The selector is resolved through the two launcher tables
//! at `0x004d23c0` and `0x004d24c0`, not through a script operand.
//!
//! This is deliberately a data-shape model. The archived script inputs do not
//! contain the process-local slot population or the native callback bodies, so
//! no default entry is fabricated and no selector is assigned text semantics.

/// Groups visited by the native scheduler's outer loop.
pub const NATIVE_CALLBACK_GROUP_COUNT: usize = 16;
/// Scheduler slots visited for every native callback group.
pub const NATIVE_CALLBACK_SLOT_COUNT: usize = 60;
/// Bytes between successive groups in the launcher context.
pub const NATIVE_CALLBACK_GROUP_STRIDE: usize = 0x85e4c;
/// Bytes between successive scheduler slots in a group.
pub const NATIVE_CALLBACK_SLOT_STRIDE: usize = 0x23a8;
/// Bytes in one work-table item.
pub const NATIVE_CALLBACK_WORK_ITEM_SIZE: usize = 0x4c;
/// Byte offset of the callback selector in a work-table item.
pub const NATIVE_CALLBACK_SELECTOR_OFFSET: usize = 0x40;

/// Opaque launcher work item with its proven callback selector exposed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeCallbackWorkItem {
    bytes: [u8; NATIVE_CALLBACK_WORK_ITEM_SIZE],
}

impl NativeCallbackWorkItem {
    /// Make a zero-filled work item with the selector stored at offset `0x40`.
    #[must_use]
    pub fn with_selector(selector: u32) -> Self {
        let mut bytes = [0; NATIVE_CALLBACK_WORK_ITEM_SIZE];
        bytes[NATIVE_CALLBACK_SELECTOR_OFFSET..NATIVE_CALLBACK_SELECTOR_OFFSET + 4]
            .copy_from_slice(&selector.to_le_bytes());
        Self { bytes }
    }

    /// The selector used by the launcher's native callback-table lookup.
    #[must_use]
    pub fn selector(&self) -> u32 {
        u32::from_le_bytes(
            self.bytes[NATIVE_CALLBACK_SELECTOR_OFFSET..NATIVE_CALLBACK_SELECTOR_OFFSET + 4]
                .try_into()
                .expect("fixed selector span"),
        )
    }
}

/// One callback invocation requested by the recovered scheduler traversal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeCallbackInvocation {
    pub group: usize,
    pub slot: usize,
    pub selector: u32,
}

/// The launcher-owned registry, represented without a launcher dependency.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NativeCallbackRegistry {
    groups: Vec<NativeCallbackGroup>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct NativeCallbackGroup {
    active: bool,
    slots: Vec<Vec<NativeCallbackWorkItem>>,
}

impl NativeCallbackRegistry {
    /// Mark a launcher-populated callback group as active.
    pub fn activate_group(&mut self, group: usize) -> bool {
        let Some(group) = self.group_mut(group) else {
            return false;
        };
        group.active = true;
        true
    }

    /// Add a work item to one registered launcher scheduler slot.
    ///
    /// Callers must have recovered this population from launcher state; this
    /// API intentionally has no script-opcode registration shortcut.
    pub fn add_work_item(
        &mut self,
        group: usize,
        slot: usize,
        item: NativeCallbackWorkItem,
    ) -> bool {
        let Some(group) = self.group_mut(group) else {
            return false;
        };
        let Some(work_items) = group.slots.get_mut(slot) else {
            return false;
        };
        work_items.push(item);
        true
    }

    /// Traverse active groups and their work tables in launcher order.
    pub fn invoke(&self, mut callback: impl FnMut(NativeCallbackInvocation)) -> usize {
        let mut invoked = 0;
        for (group_index, group) in self.groups.iter().enumerate() {
            if !group.active {
                continue;
            }
            for (slot_index, work_items) in group.slots.iter().enumerate() {
                for item in work_items {
                    callback(NativeCallbackInvocation {
                        group: group_index,
                        slot: slot_index,
                        selector: item.selector(),
                    });
                    invoked += 1;
                }
            }
        }
        invoked
    }

    fn group_mut(&mut self, group: usize) -> Option<&mut NativeCallbackGroup> {
        if group >= NATIVE_CALLBACK_GROUP_COUNT {
            return None;
        }
        while self.groups.len() <= group {
            self.groups.push(NativeCallbackGroup {
                active: false,
                slots: (0..NATIVE_CALLBACK_SLOT_COUNT)
                    .map(|_| Vec::new())
                    .collect(),
            });
        }
        self.groups.get_mut(group)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invokes_populated_work_items_in_native_group_slot_and_item_order() {
        let mut registry = NativeCallbackRegistry::default();
        assert!(registry.activate_group(15));
        assert!(registry.add_work_item(15, 59, NativeCallbackWorkItem::with_selector(9)));
        assert!(registry.add_work_item(15, 59, NativeCallbackWorkItem::with_selector(11)));
        assert!(registry.activate_group(0));
        assert!(registry.add_work_item(0, 1, NativeCallbackWorkItem::with_selector(3)));

        let mut invoked = Vec::new();
        assert_eq!(registry.invoke(|entry| invoked.push(entry)), 3);
        assert_eq!(
            invoked,
            vec![
                NativeCallbackInvocation {
                    group: 0,
                    slot: 1,
                    selector: 3
                },
                NativeCallbackInvocation {
                    group: 15,
                    slot: 59,
                    selector: 9
                },
                NativeCallbackInvocation {
                    group: 15,
                    slot: 59,
                    selector: 11
                },
            ],
            "a gutted registry cannot preserve recovered traversal and selector offsets"
        );
        assert!(!registry.add_work_item(16, 0, NativeCallbackWorkItem::with_selector(0)));
        assert!(!registry.add_work_item(0, 60, NativeCallbackWorkItem::with_selector(0)));
    }
}
