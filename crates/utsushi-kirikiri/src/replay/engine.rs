use super::*;

/// Replay `script` with default options.
#[must_use]
pub fn replay_kag(script: &KagScript) -> KagTrace {
    replay_kag_with_opts(script, &KagReplayOpts::default())
}

/// Replay `script` with explicit `opts`.
#[must_use]
pub fn replay_kag_with_opts(script: &KagScript, opts: &KagReplayOpts) -> KagTrace {
    let mut engine = Engine {
        script,
        events: Vec::new(),
        diagnostics: Vec::new(),
        speaker: None,
        current_label: None,
        choice_cursor: 0,
        variables: BTreeMap::new(),
    };
    let outcome = engine.run(opts);
    KagTrace {
        schema_version: KAG_TRACE_SCHEMA_VERSION.to_string(),
        source_file: script.source_file.clone(),
        encoding: script.encoding.as_str().to_string(),
        events: engine.events,
        diagnostics: engine.diagnostics,
        variables: engine.variables,
        outcome,
    }
}

struct Engine<'a> {
    script: &'a KagScript,
    events: Vec<KagEvent>,
    diagnostics: Vec<KagDiagnostic>,
    speaker: Option<String>,
    current_label: Option<String>,
    /// How many choice menus have been resolved (indexes into
    /// `opts.selections`).
    choice_cursor: usize,
    /// Live storage-variable state (`f.`/`sf.` name → value), evolving as
    /// supported `[eval]` assignments execute.
    variables: BTreeMap<String, VarValue>,
}

/// What a command handler decided about the program counter.
enum Flow {
    /// Advance to the next instruction.
    Next,
    /// Jump to an absolute instruction index.
    Goto(usize),
}

impl Engine<'_> {
    fn run(&mut self, opts: &KagReplayOpts) -> KagOutcome {
        let instrs = &self.script.instrs;
        let mut pc = 0usize;
        let mut steps = 0u32;
        while pc < instrs.len() {
            if steps >= opts.step_budget {
                return KagOutcome::BudgetExhausted {
                    events: self.events.len(),
                };
            }
            steps += 1;
            let flow = match &instrs[pc] {
                Instr::Label(name) => {
                    self.current_label = Some(name.clone());
                    Flow::Next
                }
                Instr::Name(speaker) => {
                    self.speaker = speaker.clone();
                    self.events.push(KagEvent::SpeakerChange {
                        speaker: speaker.clone(),
                    });
                    Flow::Next
                }
                Instr::Text(text) => {
                    self.events.push(KagEvent::Message {
                        text: text.clone(),
                        speaker: self.speaker.clone(),
                    });
                    Flow::Next
                }
                Instr::UnsupportedBlock(kind) => {
                    self.push_block_diagnostic(*kind);
                    Flow::Next
                }
                Instr::UnexpandedMacro(name) => {
                    self.push(KagDiagnosticKind::UnsupportedMacro, name);
                    Flow::Next
                }
                Instr::Command(command) => self.handle_command(command, pc, opts),
            };
            match flow {
                Flow::Next => pc += 1,
                Flow::Goto(target) => pc = target,
            }
        }
        KagOutcome::EndOfScript {
            events: self.events.len(),
        }
    }

    fn handle_command(&mut self, command: &Command, pc: usize, opts: &KagReplayOpts) -> Flow {
        let name = command.name.as_str();
        match name {
            // TJS conditional control — recognised by name (an `[if]` always
            // carries `exp=`, but it is a conditional, not a plain expr).
            "if" | "elsif" | "else" | "endif" => {
                self.push(KagDiagnosticKind::UnsupportedTjsConditional, name);
                Flow::Next
            }
            // `[macro]`/`[endmacro]` are consumed in the parser (supported
            // definitions expand silently); a stray one, or `[erasemacro]`
            // (runtime macro deletion, out of subset), is a diagnostic.
            "macro" | "endmacro" | "erasemacro" => {
                self.push(KagDiagnosticKind::UnsupportedMacro, name);
                Flow::Next
            }
            "eval" => self.handle_eval(command),
            "emb" => self.handle_emb(command),
            "jump" => self.handle_jump(command),
            "call" => {
                // `[call storage=…]` enters another script — out of scope for
                // a single-script skeleton.
                self.push(KagDiagnosticKind::UnsupportedCrossStorageJump, name);
                Flow::Next
            }
            "link" => self.handle_choice_menu(pc, opts),
            // Grouping / presentational tags the skeleton recognises and
            // deliberately treats as no-ops (documented; NOT silently
            // skipped — they are enumerated here on purpose). `endlink` is
            // consumed inside `handle_choice_menu`; a stray one is a no-op.
            "endlink" | "select" | "endselect" | "p" | "l" | "r" | "pg" | "cm" | "ct" => Flow::Next,
            // Any OTHER tag driven by a TJS expression (`exp=`/`cond=`) is a
            // TJS expression the skeleton cannot evaluate; an unadorned
            // unknown tag is a recognised-but-unmodelled command.
            _ if command.has_tjs_expression() => {
                self.push(KagDiagnosticKind::UnsupportedTjsExpression, name);
                Flow::Next
            }
            _ => {
                self.push(KagDiagnosticKind::UnsupportedCommand, name);
                Flow::Next
            }
        }
    }

    fn handle_jump(&mut self, command: &Command) -> Flow {
        // A conditional jump (`[jump cond=…]`) depends on TJS the skeleton
        // cannot evaluate; do NOT follow it — record it instead.
        if command.has_tjs_expression() {
            self.push(KagDiagnosticKind::UnsupportedTjsExpression, "jump");
            return Flow::Next;
        }
        if let Some(storage) = command.attr("storage")
            && !self.is_current_storage(storage)
        {
            self.push(KagDiagnosticKind::UnsupportedCrossStorageJump, storage);
            return Flow::Next;
        }
        if let Some(target) = command.attr("target") {
            self.jump_to(target)
        } else {
            // A same-file `[jump]` with no target is malformed; record it
            // rather than crashing.
            self.push(KagDiagnosticKind::UnsupportedCommand, "jump");
            Flow::Next
        }
    }

    /// Collect a maximal run of `[link …]…[endlink]` options starting at
    /// `pc`, present them as one [`KagEvent::Choice`], select one
    /// deterministically, and jump to its target.
    fn handle_choice_menu(&mut self, pc: usize, opts: &KagReplayOpts) -> Flow {
        let instrs = &self.script.instrs;
        let mut options: Vec<ChoiceOption> = Vec::new();
        let mut cross_storage = false;
        let mut i = pc;
        while i < instrs.len() {
            let Instr::Command(cmd) = &instrs[i] else {
                // Whitespace-only runs were dropped at parse time; a stray
                // non-command between links ends the menu.
                if is_link_separator(&instrs[i]) {
                    i += 1;
                    continue;
                }
                break;
            };
            if cmd.name != "link" {
                break;
            }
            let same_storage = cmd
                .attr("storage")
                .is_none_or(|s| self.is_current_storage(s));
            if !same_storage {
                cross_storage = true;
            }
            let target = cmd
                .attr("target")
                .map(|t| strip_label_star(t).to_string())
                .unwrap_or_default();
            let (text, next) = collect_link_text(instrs, i + 1);
            options.push(ChoiceOption { text, target });
            i = next;
        }

        if cross_storage {
            self.push(KagDiagnosticKind::UnsupportedCrossStorageJump, "link");
        }
        if options.is_empty() {
            // Should not happen (called on a `link`), but never crash.
            return Flow::Next;
        }

        let selected = opts
            .selections
            .get(self.choice_cursor)
            .copied()
            .unwrap_or(0)
            .min(options.len() - 1);
        self.choice_cursor += 1;
        let target = options[selected].target.clone();
        self.events.push(KagEvent::Choice { options, selected });
        if target.is_empty() {
            self.push(KagDiagnosticKind::UnresolvedJumpTarget, "link");
            return Flow::Next;
        }
        self.jump_to(&target)
    }

    fn jump_to(&mut self, target: &str) -> Flow {
        let label = strip_label_star(target);
        if let Some(&index) = self.script.labels.get(label) {
            self.events.push(KagEvent::Jump {
                from_label: self.current_label.clone(),
                to_label: label.to_string(),
            });
            Flow::Goto(index)
        } else {
            self.push(KagDiagnosticKind::UnresolvedJumpTarget, label);
            Flow::Next
        }
    }

    fn is_current_storage(&self, storage: &str) -> bool {
        // Compare against the source file name, tolerating a `.ks` suffix on
        // either side.
        let strip = |s: &str| s.strip_suffix(".ks").unwrap_or(s).to_string();
        strip(storage) == strip(&self.script.source_file)
    }

    fn push_block_diagnostic(&mut self, kind: BlockKind) {
        let diag = match kind {
            BlockKind::IScript => KagDiagnosticKind::UnsupportedTjsBlock,
        };
        self.push(diag, kind.as_str());
    }

    /// Handle `[eval exp="…"]`. A supported simple assignment updates variable
    /// state and records a [`KagEvent::VariableSet`]; a read of an unbound
    /// variable is an `unresolved_variable` diagnostic; anything else is an
    /// `unsupported_tjs_expression` (never a faked value).
    fn handle_eval(&mut self, command: &Command) -> Flow {
        let Some(exp) = command.attr("exp") else {
            self.push(KagDiagnosticKind::UnsupportedTjsExpression, "eval");
            return Flow::Next;
        };
        match self.eval_assignment(exp) {
            EvalOutcome::Assigned { name, value } => {
                self.variables.insert(name.clone(), value.clone());
                self.events.push(KagEvent::VariableSet { name, value });
            }
            EvalOutcome::UnresolvedVar(var) => {
                self.push(KagDiagnosticKind::UnresolvedVariable, &var);
            }
            EvalOutcome::Unsupported => {
                self.push(KagDiagnosticKind::UnsupportedTjsExpression, "eval");
            }
        }
        Flow::Next
    }

    /// Handle `[emb exp="f.x"]`. A read of a single already-bound variable
    /// records a [`KagEvent::EmbeddedValue`]; an unbound bare variable is an
    /// `unresolved_variable` diagnostic; any richer expression is an
    /// `unsupported_tjs_expression`.
    fn handle_emb(&mut self, command: &Command) -> Flow {
        let Some(exp) = command.attr("exp") else {
            self.push(KagDiagnosticKind::UnsupportedTjsExpression, "emb");
            return Flow::Next;
        };
        match parse_var_name(exp.trim()) {
            Some(name) => match self.variables.get(name) {
                Some(value) => self.events.push(KagEvent::EmbeddedValue {
                    name: name.to_string(),
                    value: value.clone(),
                }),
                None => self.push(KagDiagnosticKind::UnresolvedVariable, name),
            },
            None => self.push(KagDiagnosticKind::UnsupportedTjsExpression, "emb"),
        }
        Flow::Next
    }

    /// Parse a supported storage assignment `exp` (`f.x = RHS` / `sf.x = RHS`).
    /// Returns [`EvalOutcome::Unsupported`] for anything outside the subset —
    /// the target must be an `f.`/`sf.` variable and the RHS one of: an
    /// integer literal, a quoted string, another bound variable (copy), or a
    /// single spaced `A + B` / `A - B` over integer operands.
    fn eval_assignment(&self, exp: &str) -> EvalOutcome {
        let exp = exp.trim();
        // Reject comparisons/compound-assignments up front so a `==` is never
        // mistaken for the assignment `=`.
        if exp.contains("==")
            || exp.contains("!=")
            || exp.contains(">=")
            || exp.contains("<=")
            || exp.contains("+=")
            || exp.contains("-=")
        {
            return EvalOutcome::Unsupported;
        }
        let Some((lhs, rhs)) = exp.split_once('=') else {
            return EvalOutcome::Unsupported;
        };
        let Some(target) = parse_var_name(lhs.trim()) else {
            return EvalOutcome::Unsupported;
        };
        match self.eval_rhs(rhs.trim()) {
            RhsOutcome::Value(value) => EvalOutcome::Assigned {
                name: target.to_string(),
                value,
            },
            RhsOutcome::UnresolvedVar(var) => EvalOutcome::UnresolvedVar(var),
            RhsOutcome::Unsupported => EvalOutcome::Unsupported,
        }
    }

    /// Evaluate a supported right-hand side.
    fn eval_rhs(&self, rhs: &str) -> RhsOutcome {
        // A single operand: int literal, string literal, or a variable copy.
        match self.resolve_operand(rhs) {
            OperandOutcome::Value(v) => return RhsOutcome::Value(v),
            OperandOutcome::UnresolvedVar(var) => return RhsOutcome::UnresolvedVar(var),
            OperandOutcome::Unsupported => {}
        }
        // A single spaced `A + B` / `A - B` over integer operands.
        if let Some((a, op, b)) = split_binary(rhs) {
            let ai = match self.resolve_int(a) {
                IntOutcome::Value(v) => v,
                IntOutcome::UnresolvedVar(var) => return RhsOutcome::UnresolvedVar(var),
                IntOutcome::Unsupported => return RhsOutcome::Unsupported,
            };
            let bi = match self.resolve_int(b) {
                IntOutcome::Value(v) => v,
                IntOutcome::UnresolvedVar(var) => return RhsOutcome::UnresolvedVar(var),
                IntOutcome::Unsupported => return RhsOutcome::Unsupported,
            };
            let result = match op {
                '+' => ai.checked_add(bi),
                '-' => ai.checked_sub(bi),
                _ => None,
            };
            return match result {
                Some(v) => RhsOutcome::Value(VarValue::Int(v)),
                None => RhsOutcome::Unsupported, // overflow — refuse to fake
            };
        }
        RhsOutcome::Unsupported
    }

    /// Resolve a single operand to a [`VarValue`] (int literal, string
    /// literal, or a bound-variable copy).
    fn resolve_operand(&self, s: &str) -> OperandOutcome {
        let s = s.trim();
        if let Some(text) = string_literal(s) {
            return OperandOutcome::Value(VarValue::Str(text));
        }
        if let Ok(n) = s.parse::<i64>() {
            return OperandOutcome::Value(VarValue::Int(n));
        }
        if let Some(name) = parse_var_name(s) {
            return match self.variables.get(name) {
                Some(v) => OperandOutcome::Value(v.clone()),
                None => OperandOutcome::UnresolvedVar(name.to_string()),
            };
        }
        OperandOutcome::Unsupported
    }

    /// Resolve a single operand that MUST be an integer (literal or an
    /// int-valued bound variable) for arithmetic.
    fn resolve_int(&self, s: &str) -> IntOutcome {
        match self.resolve_operand(s) {
            OperandOutcome::Value(VarValue::Int(n)) => IntOutcome::Value(n),
            OperandOutcome::UnresolvedVar(var) => IntOutcome::UnresolvedVar(var),
            // A string operand or an unrecognised shape is not integer arithmetic.
            OperandOutcome::Value(VarValue::Str(_)) | OperandOutcome::Unsupported => {
                IntOutcome::Unsupported
            }
        }
    }

    fn push(&mut self, kind: KagDiagnosticKind, detail: &str) {
        self.diagnostics.push(KagDiagnostic {
            code: kind.code().to_string(),
            detail: detail.to_string(),
        });
    }
}
