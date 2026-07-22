use super::*;

/// Typed errors surfaced by [`GraphicsObjectStack::allocate`]
/// [`GraphicsObjectStack::set`]. Every variant carries the
/// `(plane, slot)` it failed against.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GraphicsStackError {
    /// Slot index is `>= 256`. The stack refuses to silently truncate.
    #[error(
        "graphics object slot {slot} is out of range (must be < {GRAPHICS_OBJECT_SLOT_COUNT}) on plane {plane:?}"
    )]
    SlotOutOfRange { plane: GraphicsPlane, slot: usize },
}

/// The 256-slot × 2-plane graphics object stack.
///
/// The acceptance test `graphics_object_stack_256_objects` pins:
/// - allocating 256 objects (one per slot on a single plane) is
///   accepted;
/// - the next allocation (slot 256) is rejected with
///   [`GraphicsStackError::SlotOutOfRange`];
/// - after population the stack reports `len() == 256` on the
///   populated plane and `len() == 0` on the other.
///
/// The state is dense (`Vec<Option<GraphicsObject>>` of length 256
/// per plane) so a slot lookup is `O(1)`; the empty slots carry a
/// fixed-size `None` so the total memory cost is the same regardless
/// of allocation pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphicsObjectStack {
    display_commands: Vec<Option<GraphicsObject>>,
    background_objects: Vec<Option<GraphicsObject>>,
    foreground_objects: Vec<Option<GraphicsObject>>,
    background_parents: BTreeMap<usize, GraphicsObjectParent>,
    foreground_parents: BTreeMap<usize, GraphicsObjectParent>,
}

impl GraphicsObjectStack {
    /// Construct an empty stack: all three render layers have 256
    /// `None` slots.
    pub fn new() -> Self {
        Self {
            display_commands: (0..GRAPHICS_OBJECT_SLOT_COUNT).map(|_| None).collect(),
            background_objects: (0..GRAPHICS_OBJECT_SLOT_COUNT).map(|_| None).collect(),
            foreground_objects: (0..GRAPHICS_OBJECT_SLOT_COUNT).map(|_| None).collect(),
            background_parents: BTreeMap::new(),
            foreground_parents: BTreeMap::new(),
        }
    }

    fn parents(&self, plane: GraphicsPlane) -> &BTreeMap<usize, GraphicsObjectParent> {
        match plane {
            GraphicsPlane::Background => &self.background_parents,
            GraphicsPlane::Foreground => &self.foreground_parents,
        }
    }

    fn parents_mut(&mut self, plane: GraphicsPlane) -> &mut BTreeMap<usize, GraphicsObjectParent> {
        match plane {
            GraphicsPlane::Background => &mut self.background_parents,
            GraphicsPlane::Foreground => &mut self.foreground_parents,
        }
    }

    fn materialize_parent_object(
        &mut self,
        plane: GraphicsPlane,
        parent: usize,
    ) -> Option<&mut GraphicsObject> {
        let layer = GraphicsLayer::from_plane(plane);
        if self.get_layer(layer, parent).is_none() {
            self.set_layer(layer, parent, GraphicsObject::image(""))
                .ok()?;
        }
        self.get_layer_mut(layer, parent)
    }

    fn layer_slice(&self, layer: GraphicsLayer) -> &[Option<GraphicsObject>] {
        match layer {
            GraphicsLayer::DisplayCommand => &self.display_commands,
            GraphicsLayer::BackgroundObject => &self.background_objects,
            GraphicsLayer::ForegroundObject => &self.foreground_objects,
        }
    }

    fn layer_slice_mut(&mut self, layer: GraphicsLayer) -> &mut [Option<GraphicsObject>] {
        match layer {
            GraphicsLayer::DisplayCommand => &mut self.display_commands,
            GraphicsLayer::BackgroundObject => &mut self.background_objects,
            GraphicsLayer::ForegroundObject => &mut self.foreground_objects,
        }
    }

    /// Store `object` at `(plane, slot)`. Overwrites whatever was
    /// there. Returns [`GraphicsStackError::SlotOutOfRange`] if `slot
    /// >= 256`.
    pub fn set(
        &mut self,
        plane: GraphicsPlane,
        slot: usize,
        object: GraphicsObject,
    ) -> Result<(), GraphicsStackError> {
        self.set_layer(GraphicsLayer::from_plane(plane), slot, object)
            .map_err(|_| GraphicsStackError::SlotOutOfRange { plane, slot })
    }

    /// Store `object` at `(layer, slot)`. Overwrites whatever was
    /// there. Returns [`GraphicsStackError::SlotOutOfRange`] if `slot
    /// >= 256`.
    pub fn set_layer(
        &mut self,
        layer: GraphicsLayer,
        slot: usize,
        object: GraphicsObject,
    ) -> Result<(), GraphicsStackError> {
        if slot >= GRAPHICS_OBJECT_SLOT_COUNT {
            return Err(GraphicsStackError::SlotOutOfRange {
                plane: layer.diagnostic_plane(),
                slot,
            });
        }
        self.layer_slice_mut(layer)[slot] = Some(object);
        Ok(())
    }

    /// Free `(plane, slot)` (sets it to `None`). No-op if already
    /// `None`. Returns [`GraphicsStackError::SlotOutOfRange`] if `slot
    /// >= 256`.
    pub fn clear(&mut self, plane: GraphicsPlane, slot: usize) -> Result<(), GraphicsStackError> {
        self.clear_layer(GraphicsLayer::from_plane(plane), slot)
            .map_err(|_| GraphicsStackError::SlotOutOfRange { plane, slot })
    }

    /// Free `(layer, slot)` (sets it to `None`). No-op if already
    /// `None`. Returns [`GraphicsStackError::SlotOutOfRange`] if `slot
    /// >= 256`.
    pub fn clear_layer(
        &mut self,
        layer: GraphicsLayer,
        slot: usize,
    ) -> Result<(), GraphicsStackError> {
        if slot >= GRAPHICS_OBJECT_SLOT_COUNT {
            return Err(GraphicsStackError::SlotOutOfRange {
                plane: layer.diagnostic_plane(),
                slot,
            });
        }
        self.layer_slice_mut(layer)[slot] = None;
        Ok(())
    }

    /// Borrow the object at `(plane, slot)`, or `None` if the slot is
    /// free or out of range.
    pub fn get(&self, plane: GraphicsPlane, slot: usize) -> Option<&GraphicsObject> {
        self.get_layer(GraphicsLayer::from_plane(plane), slot)
    }

    /// Borrow the object at `(layer, slot)`, or `None` if the slot is
    /// free or out of range.
    pub fn get_layer(&self, layer: GraphicsLayer, slot: usize) -> Option<&GraphicsObject> {
        if slot >= GRAPHICS_OBJECT_SLOT_COUNT {
            return None;
        }
        self.layer_slice(layer)[slot].as_ref()
    }

    /// Mutably borrow the object at `(plane, slot)`, or `None` if the
    /// slot is free or out of range.
    pub fn get_mut(&mut self, plane: GraphicsPlane, slot: usize) -> Option<&mut GraphicsObject> {
        self.get_layer_mut(GraphicsLayer::from_plane(plane), slot)
    }

    /// Mutably borrow the object at `(layer, slot)`, or `None` if the
    /// slot is free or out of range.
    pub fn get_layer_mut(
        &mut self,
        layer: GraphicsLayer,
        slot: usize,
    ) -> Option<&mut GraphicsObject> {
        if slot >= GRAPHICS_OBJECT_SLOT_COUNT {
            return None;
        }
        self.layer_slice_mut(layer)[slot].as_mut()
    }

    pub fn target(&self, target: GraphicsObjectTarget) -> Option<&GraphicsObject> {
        match target {
            GraphicsObjectTarget::TopLevel { layer, slot } => self.get_layer(layer, slot),
            GraphicsObjectTarget::Child {
                plane,
                parent,
                child,
            } => self.parents(plane).get(&parent)?.children.get(&child),
        }
    }

    pub fn target_mut(&mut self, target: GraphicsObjectTarget) -> Option<&mut GraphicsObject> {
        match target {
            GraphicsObjectTarget::TopLevel { layer, slot } => self.get_layer_mut(layer, slot),
            GraphicsObjectTarget::Child {
                plane,
                parent,
                child,
            } => self
                .parents_mut(plane)
                .get_mut(&parent)?
                .children
                .get_mut(&child),
        }
    }

    pub fn create_parent(
        &mut self,
        plane: GraphicsPlane,
        parent: usize,
        declared_capacity: usize,
        visible: Option<bool>,
        position: Option<GraphicsPosition>,
    ) -> bool {
        if parent >= GRAPHICS_OBJECT_SLOT_COUNT {
            return false;
        }
        let Some(object) = self.materialize_parent_object(plane, parent) else {
            return false;
        };
        if let Some(visible) = visible {
            object.visible = visible;
        }
        if let Some(position) = position {
            object.position = position;
        }
        self.parents_mut(plane)
            .insert(parent, GraphicsObjectParent::new(declared_capacity));
        true
    }

    pub fn set_child(
        &mut self,
        plane: GraphicsPlane,
        parent: usize,
        child: usize,
        object: GraphicsObject,
    ) -> bool {
        if parent >= GRAPHICS_OBJECT_SLOT_COUNT {
            return false;
        }
        let capacity = self
            .parents(plane)
            .get(&parent)
            .map_or(GRAPHICS_OBJECT_SLOT_COUNT, |entry| entry.declared_capacity);
        if child >= capacity {
            return false;
        }
        if self.materialize_parent_object(plane, parent).is_none() {
            return false;
        }
        self.parents_mut(plane)
            .entry(parent)
            .or_insert_with(|| GraphicsObjectParent::new(GRAPHICS_OBJECT_SLOT_COUNT))
            .children
            .insert(child, object);
        true
    }

    pub fn parent(&self, plane: GraphicsPlane, parent: usize) -> Option<&GraphicsObjectParent> {
        self.parents(plane).get(&parent)
    }

    /// Number of allocated slots on `plane`.
    pub fn plane_len(&self, plane: GraphicsPlane) -> usize {
        self.layer_len(GraphicsLayer::from_plane(plane))
    }

    /// Number of allocated slots on `layer`.
    pub fn layer_len(&self, layer: GraphicsLayer) -> usize {
        self.layer_slice(layer)
            .iter()
            .filter(|s| s.is_some())
            .count()
    }

    /// Total allocated slot count across all render layers.
    pub fn len(&self) -> usize {
        self.layer_len(GraphicsLayer::DisplayCommand)
            + self.layer_len(GraphicsLayer::BackgroundObject)
            + self.layer_len(GraphicsLayer::ForegroundObject)
    }

    /// True iff no slots are allocated on any render layer.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Iterate `(plane, slot, &GraphicsObject)` over **allocated**
    /// slots only, projected through the legacy two-plane API. The
    /// render pass uses [`Self::iter_allocated_layers`] instead so bg
    /// objects and fg objects with the same slot stay distinct.
    pub fn iter_allocated(&self) -> impl Iterator<Item = (GraphicsPlane, usize, &GraphicsObject)> {
        self.iter_allocated_layers()
            .map(|(layer, slot, object)| (layer.diagnostic_plane(), slot, object))
    }

    /// Iterate `(layer, slot, &GraphicsObject)` over allocated slots in
    /// deterministic compositor-layer order.
    pub fn iter_allocated_layers(
        &self,
    ) -> impl Iterator<Item = (GraphicsLayer, usize, &GraphicsObject)> {
        let layers = [
            GraphicsLayer::DisplayCommand,
            GraphicsLayer::BackgroundObject,
            GraphicsLayer::ForegroundObject,
        ];
        layers.into_iter().flat_map(move |layer| {
            self.layer_slice(layer)
                .iter()
                .enumerate()
                .filter_map(move |(slot, entry)| entry.as_ref().map(|object| (layer, slot, object)))
        })
    }
}

impl Default for GraphicsObjectStack {
    fn default() -> Self {
        Self::new()
    }
}
