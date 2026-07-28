//! MV/MZ PLUGIN-owned text via declared plugin profiles.
//! RPG Maker MV/MZ games load PLUGINS (`js/plugins/*.js` + the `js/plugins.js`
//! config) that own their own player-facing text through **plugin
//! parameters** (a message-box plugin's window title, a name-input plugin's
//! prompt, …). Those parameters live in `js/plugins.js` as a
//! `var $plugins = [ … ];` array of `{ name, status, description, parameters }`
//! objects. This slice represents that plugin-owned text — but ONLY through a
//! **declared plugin profile**: a plugin parameter is extractable *iff* a
//! profile declares the JSON pointer that holds it.
//! This is the honest boundary. A plugin's parameter object mixes translatable
//! text with configuration, numeric strings, switch/variable ids, colour
//! codes and file names; without a per-plugin profile we cannot know which
//! parameters carry player-facing text. So we DO NOT blind-sweep every plugin
//! string. Instead:
//! - A plugin **with a declared profile** → text is extracted at exactly the
//!   declared parameter pointers as stable units ([`StablePluginTextUnit`]),
//!   and patched back byte-preservingly (reusing the splice).
//! - A plugin **without a declared profile** that carries string parameters →
//!   one typed [`PluginDiagnosticKind::UnsupportedPluginProfile`] diagnostic
//!   (never a silent skip, never a blind all-strings sweep).
//! - A declared pointer that resolves to a **non-text** value (a numeric /
//!   switch string mistake) or does not resolve → a typed
//!   [`PluginDiagnosticKind::UnsupportedDeclaredPointer`] diagnostic; it is
//!   NOT extracted.
//! # `js/plugins.js` shape (no JS execution)
//! `plugins.js` is a JS assignment wrapping a JSON array:
//! `var $plugins =\n[ {…}, {…} ];`. We NEVER execute the plugin JS. We split
//! the file into `(prefix, <JSON array bytes>, suffix)` at the `$plugins`
//! array literal, parse only the array as JSON, and patch only the array bytes
//! — the `var $plugins =` prefix and the trailing `;` suffix are preserved
//! verbatim, so the whole file stays byte-identical outside the declared
//! parameter literals.
//! # Stable unit + profile output (acceptance)
//! Every [`StablePluginTextUnit`] carries `source_file`, the plugin name plus
//! declared id, the plugin array index, the parameter pointer, the text role,
//! the patchability, and the fixture-profile id. Its stable
//! `rpgmaker:plugins.js#<json-pointer>` [`source_unit_key`] and deterministic
//! [`bridge_unit_id`] use the same scheme as the sibling slices. Each
//! profiled plugin also emits a [`ProfiledPlugin`] record with the plugin id,
//! the version-or-fixture-hash (the profile's declared version, plus a content
//! `fixture_hash` over the plugin entry bytes), and the declared parameter
//! pointers — acceptance (2).
//! [`source_unit_key`]: StablePluginTextUnit::source_unit_key
//! [`bridge_unit_id`]: StablePluginTextUnit::bridge_unit_id

include!("plugin_profile_parts/001.rs");
include!("plugin_profile_parts/002.rs");
