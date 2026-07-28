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

    fn vfs_warning(asset_name: &str, err: VfsError) -> GraphicsRuntimeWarning {
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

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, GraphicsRuntimeInner> {
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

/// Typed wrapper around the `Fade` private state. Carries the alpha
/// endpoints and the total tick count the substrate scheduler will
/// advance through.
///
/// # Payload shape
///
/// `[FADE_PRIVATE_STATE_MAGIC (1B), starting_alpha (1B), target_alpha
/// (1B), total_ticks_LE (8B), elapsed_ticks_LE (8B)]` — 19 bytes total.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FadeLongOp {
    id: LongOpId,
    starting_alpha: u8,
    target_alpha: u8,
    total_ticks: u64,
    elapsed_ticks: u64,
}

impl FadeLongOp {
    pub const PAYLOAD_BYTE_LEN: usize = 19;

    /// Build a fresh fade longop. The `elapsed_ticks` field starts at
    /// `0`; the scheduler increments it through [`Self::advance`] and
    /// then re-encodes the payload through [`Self::write_into_payload`].
    pub fn new(id: LongOpId, starting_alpha: u8, target_alpha: u8, total_ticks: u64) -> Self {
        Self {
            id,
            starting_alpha,
            target_alpha,
            total_ticks,
            elapsed_ticks: 0,
        }
    }

    pub fn id(&self) -> LongOpId {
        self.id
    }

    pub fn starting_alpha(&self) -> u8 {
        self.starting_alpha
    }

    pub fn target_alpha(&self) -> u8 {
        self.target_alpha
    }

    pub fn total_ticks(&self) -> u64 {
        self.total_ticks
    }

    pub fn elapsed_ticks(&self) -> u64 {
        self.elapsed_ticks
    }

    /// Whether the fade has run its full tick budget.
    pub fn is_complete(&self) -> bool {
        self.elapsed_ticks >= self.total_ticks
    }

    /// Linear-interpolated alpha for the current elapsed ticks. Pinned
    /// so the substrate-honest "no float drift" guarantee holds.
    pub fn current_alpha(&self) -> u8 {
        if self.total_ticks == 0 || self.is_complete() {
            return self.target_alpha;
        }
        let start = self.starting_alpha as i64;
        let target = self.target_alpha as i64;
        let elapsed = self.elapsed_ticks as i64;
        let total = self.total_ticks as i64;
        // value = start + (target - start) * elapsed / total
        let span = target - start;
        let delta = span * elapsed / total;
        let value = start + delta;
        value.clamp(0, 255) as u8
    }

    /// Advance the fade by `ticks` ticks. Saturates at `total_ticks`.
    pub fn advance(&mut self, ticks: u64) {
        self.elapsed_ticks = self
            .elapsed_ticks
            .saturating_add(ticks)
            .min(self.total_ticks);
    }

    /// Encode the wrapper into a [`LongOp`] carrier.
    pub fn into_longop(self) -> LongOp {
        let mut payload = Vec::with_capacity(Self::PAYLOAD_BYTE_LEN);
        payload.push(FADE_PRIVATE_STATE_MAGIC);
        payload.push(self.starting_alpha);
        payload.push(self.target_alpha);
        payload.extend_from_slice(&self.total_ticks.to_le_bytes());
        payload.extend_from_slice(&self.elapsed_ticks.to_le_bytes());
        LongOp::new(self.id, payload)
    }

    /// Decode a payload back into a `FadeLongOp`. Returns a typed error
    /// on length or magic mismatch.
    pub fn try_from_payload(id: LongOpId, payload: &[u8]) -> Result<Self, FadeLongOpDecodeError> {
        if payload.len() != Self::PAYLOAD_BYTE_LEN {
            return Err(FadeLongOpDecodeError::UnexpectedPayloadLength {
                observed: payload.len(),
                expected: Self::PAYLOAD_BYTE_LEN,
            });
        }
        if payload[0] != FADE_PRIVATE_STATE_MAGIC {
            return Err(FadeLongOpDecodeError::MagicMismatch {
                observed: payload[0],
                expected: FADE_PRIVATE_STATE_MAGIC,
            });
        }
        let starting_alpha = payload[1];
        let target_alpha = payload[2];
        let total_ticks = u64::from_le_bytes(payload[3..11].try_into().expect("11-3=8"));
        let elapsed_ticks = u64::from_le_bytes(payload[11..19].try_into().expect("19-11=8"));
        Ok(Self {
            id,
            starting_alpha,
            target_alpha,
            total_ticks,
            elapsed_ticks,
        })
    }
}

/// Typed decode error for [`FadeLongOp::try_from_payload`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum FadeLongOpDecodeError {
    #[error("utsushi.reallive.rlop.fade.payload_length: observed={observed} expected={expected}")]
    UnexpectedPayloadLength { observed: usize, expected: usize },
    #[error(
        "utsushi.reallive.rlop.fade.magic_mismatch: observed=0x{observed:02x} expected=0x{expected:02x}"
    )]
    MagicMismatch { observed: u8, expected: u8 },
}

/// `objButtonOpts` (`obj (1,{81,82},1064)`) binds the authoritative
/// `(buf, action, se, group, button_number)` tuple to the exact graphics
/// object at `(plane, buf)`. Bad shapes, invalid slots, and empty slots fail
/// soft without creating a binding. The current foreground-only group query
/// is an inspection seam; select/resume mapping and rendering stay separate.
#[derive(Debug)]
pub struct ObjButtonOptsOp {
    runtime: Arc<GraphicsRuntime>,
    plane: GraphicsPlane,
    child_addressed: bool,
}

impl ObjButtonOptsOp {
    pub fn new(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane) -> Self {
        Self {
            runtime,
            plane,
            child_addressed: false,
        }
    }

    pub fn new_child(runtime: Arc<GraphicsRuntime>, plane: GraphicsPlane) -> Self {
        Self {
            runtime,
            plane,
            child_addressed: true,
        }
    }
}


