use super::types::*;
use crate::g00::{G00DecodeError, G00Warning, decode_g00};
use crate::graphics_objects::{GraphicsObjectStack, GraphicsStackError};
use crate::rlop::LongOpId;
use std::sync::{Arc, Mutex};
use utsushi_core::substrate::{AssetPackage, VfsError};

/// Shared runtime carrier for every `module_grp` and `module_obj_*`
/// op. Owns the graphics object stack, the optional VFS surface, the
/// long-op id sequence used by `grp.fade`, the recorded fade tick
/// rate, and the fail-soft warning queue.
pub struct GraphicsRuntime {
    inner: Mutex<GraphicsRuntimeInner>,
}

pub(super) struct GraphicsRuntimeInner {
    stack: GraphicsObjectStack,
    dc_allocations: Vec<DcAllocation>,
    shake_amplitude_px: u32,
    bg_canvas: Option<BgCanvas>,
    fade_scheduled: Option<FadeSchedule>,
    fade_ticks_per_ms: u64,
    pub(super) asset_package: Option<Arc<dyn AssetPackage>>,
    next_longop_id: u64,
    warnings: Vec<GraphicsRuntimeWarning>,
}

impl std::fmt::Debug for GraphicsRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GraphicsRuntime")
            .field("allocated_slot_count", &self.allocated_slot_count())
            .finish()
    }
}

impl GraphicsRuntime {
    /// Build a runtime with an empty stack, no VFS, and the default
    /// fade tick rate ([`DEFAULT_FADE_TICKS_PER_MS`]).
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(GraphicsRuntimeInner {
                stack: GraphicsObjectStack::new(),
                dc_allocations: Vec::new(),
                shake_amplitude_px: 0,
                bg_canvas: None,
                fade_scheduled: None,
                fade_ticks_per_ms: DEFAULT_FADE_TICKS_PER_MS,
                asset_package: None,
                next_longop_id: 1,
                warnings: Vec::new(),
            }),
        }
    }

    /// Override the ticks-per-ms rate used by `grp.fade`. Tests use
    /// this to make the longop duration observable without scaling the
    /// fixture clock.
    pub fn set_fade_ticks_per_ms(&self, ticks_per_ms: u64) {
        self.lock_inner().fade_ticks_per_ms = ticks_per_ms.max(1);
    }

    /// Borrow the current fade ticks-per-ms rate.
    pub fn fade_ticks_per_ms(&self) -> u64 {
        self.lock_inner().fade_ticks_per_ms
    }

    /// Bind the substrate VFS surface the `openBg`-style ops consult.
    /// `module_grp::openBg` looks up `g00/<NAME>.g00` against the
    /// resolved [`AssetPackage::resolve`] path.
    pub fn set_asset_package(&self, package: Arc<dyn AssetPackage>) {
        self.lock_inner().asset_package = Some(package);
    }

    /// Number of slots allocated on the stack across both planes.
    pub fn allocated_slot_count(&self) -> usize {
        self.lock_inner().stack.len()
    }

    /// Emit a fresh long-op id. The id sequence starts at `1` and
    /// monotonically increases; the substrate-honest "no PII" posture
    /// is unaffected because the value is opaque.
    pub fn next_longop_id(&self) -> LongOpId {
        let mut guard = self.lock_inner();
        let id = guard.next_longop_id;
        guard.next_longop_id = guard.next_longop_id.saturating_add(1);
        LongOpId(id)
    }

    /// Borrow a typed observable snapshot of the runtime state.
    pub fn state_snapshot(&self) -> GraphicsStateSnapshot {
        let guard = self.lock_inner();
        GraphicsStateSnapshot {
            stack: guard.stack.clone(),
            dc_allocations: guard.dc_allocations.clone(),
            shake_amplitude_px: guard.shake_amplitude_px,
            bg_canvas: guard.bg_canvas.clone(),
            fade_scheduled: guard.fade_scheduled,
        }
    }

    /// Read-only access to the object stack.
    pub fn with_stack<R>(&self, body: impl FnOnce(&GraphicsObjectStack) -> R) -> R {
        body(&self.lock_inner().stack)
    }

    /// Mutable access to the object stack.
    pub fn with_stack_mut<R>(&self, body: impl FnOnce(&mut GraphicsObjectStack) -> R) -> R {
        body(&mut self.lock_inner().stack)
    }

    /// Record a DC-allocation observation. Overwrites any prior entry
    /// for the same slot.
    pub fn set_dc_allocation(&self, slot: usize, width: u32, height: u32) {
        let mut guard = self.lock_inner();
        guard.dc_allocations.retain(|dc| dc.slot != slot);
        guard.dc_allocations.push(DcAllocation {
            slot,
            width,
            height,
        });
    }

    pub fn set_shake_amplitude_px(&self, amplitude_px: u32) {
        self.lock_inner().shake_amplitude_px = amplitude_px;
    }

    /// Record a bg-plane canvas observation with decoded dimensions.
    pub fn record_bg_canvas(&self, asset_key: &str, width: u32, height: u32) {
        self.lock_inner().bg_canvas = Some(BgCanvas {
            asset_key: asset_key.to_string(),
            dimensions: Some((width, height)),
        });
    }

    /// Record a bg-plane asset observation without dimensions (no
    /// VFS was set).
    pub fn record_bg_asset_only(&self, asset_key: &str) {
        self.lock_inner().bg_canvas = Some(BgCanvas {
            asset_key: asset_key.to_string(),
            dimensions: None,
        });
    }

    /// Record that `grp.fade` scheduled a longop.
    pub fn record_fade_scheduled(&self, starting_alpha: u8, target_alpha: u8, total_ticks: u64) {
        self.lock_inner().fade_scheduled = Some(FadeSchedule {
            starting_alpha,
            target_alpha,
            total_ticks,
        });
    }

    /// Append a fail-soft warning to the runtime's diagnostic queue.
    pub fn push_warning(&self, warning: GraphicsRuntimeWarning) {
        self.lock_inner().warnings.push(warning);
    }

    /// Route a [`GraphicsStackError`] into the runtime diagnostic sink rather
    /// than silently discarding a `stack.set`/`clear` Result (var-banks posture).
    /// Call **outside** [`Self::with_stack_mut`] so the inner mutex is not re-entered.
    pub fn route_stack_error(&self, error: GraphicsStackError) {
        match error {
            GraphicsStackError::SlotOutOfRange { slot, .. } => {
                self.push_warning(GraphicsRuntimeWarning::SlotOutOfRange {
                    slot: i32::try_from(slot).unwrap_or(i32::MAX),
                });
            }
        }
    }

    /// Observe a stack `set`/`clear` Result and route any error into the
    /// diagnostic sink. Success is a no-op (graphics behavior unchanged).
    pub fn route_stack_result(&self, result: Result<(), GraphicsStackError>) {
        if let Err(error) = result {
            self.route_stack_error(error);
        }
    }

    /// Drain the fail-soft warnings.
    pub fn take_warnings(&self) -> Vec<GraphicsRuntimeWarning> {
        std::mem::take(&mut self.lock_inner().warnings)
    }

    /// Borrow the fail-soft warnings without draining.
    pub fn warnings(&self) -> Vec<GraphicsRuntimeWarning> {
        self.lock_inner().warnings.clone()
    }

    /// Resolve `g00/<asset_name>.g00` through the substrate VFS
    /// decode the bytes, and return the decoded `(width, height)`.
    /// Returns `Ok(None)` when no asset package was set so the caller
    /// can record the gap observably. Non-fatal [`crate::g00::G00Warning`]
    /// entries the decoder returns alongside the image are pushed onto
    /// the runtime's warning queue (under
    /// [`GraphicsRuntimeWarning::G00PayloadWarning`]) — they are NOT
    /// discarded at the dims-probe boundary, so a corpus LZSS drift
    /// surfaces observably instead of being silently rounded to the
    /// canvas size. The fatal `Err` arm is unchanged (still returns
    /// [`GraphicsRuntimeWarning::G00DecodeFailure`] for the caller to
    /// tag with the dispatch opcode).
    ///
    /// `opcode_tag` is stamped on every emitted `G00PayloadWarning` so
    /// the dims-probe origin is named in the audit trail; pass the
    /// dispatch op's [`RLOperation::tag`] (or `""` when no dispatch
    /// context is available). Tests that don't care about the stamp
    /// may pass `""`.
    pub fn read_g00_through_vfs(
        &self,
        asset_name: &str,
        opcode_tag: &'static str,
    ) -> Result<Option<(u32, u32)>, GraphicsRuntimeWarning> {
        let package = {
            let guard = self.lock_inner();
            guard.asset_package.clone()
        };
        let Some(package) = package else {
            return Ok(None);
        };
        let logical = format!("g00/{asset_name}.g00");
        let id = package
            .resolve(&logical)
            .map_err(|err| Self::vfs_warning(asset_name, err))?;
        let bytes = package
            .open(&id)
            .map_err(|err| Self::vfs_warning(asset_name, err))?;
        match decode_g00(bytes.as_slice()) {
            Ok((image, warnings)) => {
                for warning in warnings {
                    self.push_warning(Self::g00_payload_warning(asset_name, opcode_tag, &warning));
                }
                Ok(Some((image.width, image.height)))
            }
            Err(err) => Err(Self::g00_warning(asset_name, err)),
        }
    }

    pub(super) fn vfs_warning(asset_name: &str, err: VfsError) -> GraphicsRuntimeWarning {
        GraphicsRuntimeWarning::VfsFailure {
            opcode_tag: "",
            asset_key: asset_name.to_string(),
            reason: err.to_string(),
        }
    }

    fn g00_warning(asset_name: &str, err: G00DecodeError) -> GraphicsRuntimeWarning {
        GraphicsRuntimeWarning::G00DecodeFailure {
            opcode_tag: "",
            asset_key: asset_name.to_string(),
            reason: err.to_string(),
        }
    }

    /// Translate a non-fatal [`crate::g00::G00Warning`] into a
    /// [`GraphicsRuntimeWarning::G00PayloadWarning`] stamped with the
    /// dims-probe's asset key AND the dispatcher's `opcode_tag` (so the
    /// audit trail names both the g00 origin and the rgrop that triggered
    /// the probe). The `Display` impl of [`crate::g00::G00Warning`]
    /// renders the diagnostic prefix (`utsushi.reallive.g00.…`) so the
    /// resulting warning text carries the original stable code plus the
    /// runtime-owned opcode / asset framing.
    fn g00_payload_warning(
        asset_name: &str,
        opcode_tag: &'static str,
        warning: &G00Warning,
    ) -> GraphicsRuntimeWarning {
        GraphicsRuntimeWarning::G00PayloadWarning {
            opcode_tag,
            asset_key: asset_name.to_string(),
            reason: warning.to_string(),
        }
    }

    pub(super) fn lock_inner(&self) -> std::sync::MutexGuard<'_, GraphicsRuntimeInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl Default for GraphicsRuntime {
    fn default() -> Self {
        Self::new()
    }
}
