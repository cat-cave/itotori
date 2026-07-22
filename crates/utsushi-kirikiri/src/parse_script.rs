use super::*;

/// Parse `bytes` as a plaintext KAG `.ks` script, auto-detecting the
/// encoding.
#[must_use]
pub fn parse_kag(source_file: &str, bytes: &[u8]) -> KagScript {
    let encoding = KagEncoding::detect(bytes);
    parse_kag_with_encoding(source_file, bytes, encoding)
}

/// Parse `bytes` under an explicit `encoding`.
#[must_use]
pub fn parse_kag_with_encoding(
    source_file: &str,
    bytes: &[u8],
    encoding: KagEncoding,
) -> KagScript {
    let text = encoding.decode(bytes);
    let mut instrs: Vec<Instr> = Vec::new();

    // Defined macros: name -> raw body lines (captured verbatim, expanded on
    // invocation). Built as the linear scan proceeds, so a macro can only be
    // invoked after it is defined (matching a linear KAG load).
    let mut macros: BTreeMap<String, Vec<String>> = BTreeMap::new();
    // While `Some((name, body))`, physical lines are captured into a macro
    // definition until `[endmacro]` closes it.
    let mut open_macro: Option<(String, Vec<String>)> = None;
    // While `true`, physical lines are swallowed as `[iscript]` TJS body.
    let mut open_iscript = false;

    for raw_line in text.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);

        // 1. Capturing a macro definition body.
        if let Some((_, body)) = open_macro.as_mut() {
            if line_contains_tag(line, "endmacro") {
                let (name, body) = open_macro.take().expect("open_macro is Some");
                define_macro(name, body, &mut macros, &mut instrs);
            } else {
                body.push(line.to_string());
            }
            continue;
        }

        // 2. Swallowing an `[iscript]` block body.
        if open_iscript {
            if line_contains_tag(line, "endscript") {
                instrs.push(Instr::UnsupportedBlock(BlockKind::IScript));
                open_iscript = false;
            }
            continue;
        }

        // 3. A line whose FIRST inline tag opens a macro definition.
        if let Some(cmd) = leading_command(line)
            && cmd.name == "macro"
        {
            let name = cmd.attr("name").unwrap_or("").to_string();
            if line_contains_tag(line, "endmacro") {
                // Single-line `[macro name=x]body[endmacro]`.
                let body = single_line_macro_body(line);
                define_macro(name, body, &mut macros, &mut instrs);
            } else {
                open_macro = Some((name, Vec::new()));
            }
            continue;
        }

        // 4. A line whose FIRST inline tag opens an `[iscript]` block.
        if leading_tag_name(line.trim_start()).as_deref() == Some("iscript") {
            if line_contains_tag(line, "endscript") {
                instrs.push(Instr::UnsupportedBlock(BlockKind::IScript));
            } else {
                open_iscript = true;
            }
            continue;
        }

        // 5. An ordinary line: parse it, expanding any macro invocations.
        emit_line(line, &macros, &mut instrs, 0);
    }

    // An unterminated block/definition still surfaces its marker (recorded
    // not lost).
    if open_iscript {
        instrs.push(Instr::UnsupportedBlock(BlockKind::IScript));
    }
    if let Some((name, _)) = open_macro {
        instrs.push(Instr::UnexpandedMacro(macro_detail(&name)));
    }

    let labels = index_labels(&instrs);
    KagScript {
        source_file: source_file.to_string(),
        encoding,
        instrs,
        labels,
    }
}

/// Record a finished macro definition. A nameless definition cannot be
/// invoked, so it surfaces a typed `unsupported_macro` diagnostic instead of
/// being silently dropped.
fn define_macro(
    name: String,
    body: Vec<String>,
    macros: &mut BTreeMap<String, Vec<String>>,
    instrs: &mut Vec<Instr>,
) {
    if name.is_empty() {
        instrs.push(Instr::UnexpandedMacro(macro_detail(&name)));
    } else {
        macros.insert(name, body);
    }
}

fn macro_detail(name: &str) -> String {
    if name.is_empty() {
        "macro".to_string()
    } else {
        name.to_string()
    }
}

fn index_labels(instrs: &[Instr]) -> BTreeMap<String, usize> {
    let mut labels = BTreeMap::new();
    for (index, instr) in instrs.iter().enumerate() {
        if let Instr::Label(name) = instr {
            labels.insert(name.clone(), index);
        }
    }
    labels
}

/// Parse one physical `line` into instructions, EXPANDING any inline command
/// that names a defined macro. Non-macro instructions pass through unchanged.
fn emit_line(
    line: &str,
    macros: &BTreeMap<String, Vec<String>>,
    instrs: &mut Vec<Instr>,
    depth: u32,
) {
    let mut parsed: Vec<Instr> = Vec::new();
    parse_line(line, &mut parsed);
    for instr in parsed {
        match instr {
            Instr::Command(cmd) if macros.contains_key(&cmd.name) => {
                expand_invocation(&cmd, macros, instrs, depth);
            }
            other => instrs.push(other),
        }
    }
}

/// Expand a macro invocation `cmd` by splicing its (parameter-substituted)
/// body into `instrs`. A `%param` with no supplied attribute and no default
/// or nesting past [`MAX_MACRO_DEPTH`], is NOT faked — the whole invocation
/// collapses to a single [`Instr::UnexpandedMacro`].
fn expand_invocation(
    cmd: &Command,
    macros: &BTreeMap<String, Vec<String>>,
    instrs: &mut Vec<Instr>,
    depth: u32,
) {
    if depth >= MAX_MACRO_DEPTH {
        instrs.push(Instr::UnexpandedMacro(cmd.name.clone()));
        return;
    }
    let body = &macros[&cmd.name];
    // Resolve every body line up front: if any `%param` is unresolved, the
    // invocation is out of subset and NOTHING is emitted (no partial/faked
    // expansion).
    let mut substituted: Vec<String> = Vec::with_capacity(body.len());
    for body_line in body {
        match substitute_params(body_line, &cmd.attrs) {
            Ok(line) => substituted.push(line),
            Err(_missing_param) => {
                instrs.push(Instr::UnexpandedMacro(cmd.name.clone()));
                return;
            }
        }
    }
    for line in substituted {
        emit_line(&line, macros, instrs, depth + 1);
    }
}

/// Substitute `%param` references in a macro body line from the invocation
/// `attrs`. `%name` takes the invocation's `name=` value; `%name|default`
/// falls back to `default` when the attribute is absent. A `%param` with
/// neither an attribute nor a default is [`Err`] (the invocation is out of
/// subset). A lone `%` (not followed by an identifier) is a literal `%`.
fn substitute_params(line: &str, attrs: &[Attr]) -> Result<String, String> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '%' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        // Read the parameter identifier following `%`.
        let mut j = i + 1;
        let mut ident = String::new();
        while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
            ident.push(chars[j]);
            j += 1;
        }
        if ident.is_empty() {
            out.push('%'); // lone `%` — literal
            i += 1;
            continue;
        }
        // Optional `|default` (terminated by whitespace, `]`, or a quote).
        let mut default: Option<String> = None;
        if j < chars.len() && chars[j] == '|' {
            j += 1;
            let mut d = String::new();
            while j < chars.len()
                && !chars[j].is_whitespace()
                && chars[j] != ']'
                && chars[j] != '"'
                && chars[j] != '\''
            {
                d.push(chars[j]);
                j += 1;
            }
            default = Some(d);
        }
        let value = attrs
            .iter()
            .find(|a| a.key == ident)
            .map(|a| a.value.clone())
            .or(default)
            .ok_or_else(|| ident.clone())?;
        out.push_str(&value);
        i = j;
    }
    Ok(out)
}
