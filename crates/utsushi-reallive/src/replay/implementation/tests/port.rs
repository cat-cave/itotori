use super::*;

#[test]
fn selected_port_pass_keeps_prompt_trace_aligned_with_its_lines() {
    let branch_prompt = prompt(1, "branch-line");
    let linear_prompt = prompt(2, "linear-line");
    // Branch reached a terminus → its play order is authoritative.
    let (lines, prompts) = select_port_pass(
        vec![line("branch-line")],
        vec![branch_prompt.clone()],
        PassTermination::NaturalTerminus,
        vec![line("linear-line")],
        vec![linear_prompt.clone()],
        PassTermination::NaturalTerminus,
    );
    assert_eq!(lines[0].line_id, "branch-line");
    assert_eq!(prompts, vec![branch_prompt]);

    // Branch reached no dialogue → linear catalogue fallback (existing).
    let (lines, prompts) = select_port_pass(
        vec![],
        vec![prompt(3, "unused-branch-prompt")],
        PassTermination::NaturalTerminus,
        vec![line("linear-line")],
        vec![linear_prompt.clone()],
        PassTermination::NaturalTerminus,
    );
    assert_eq!(lines[0].line_id, "linear-line");
    assert_eq!(prompts, vec![linear_prompt]);
}

#[test]
fn selected_port_pass_falls_back_to_linear_when_branch_spins() {
    // A headless select/redraw SPIN: the branch pass emitted many
    // (duplicated) prompt lines but never reached a natural terminus
    // while the byte-order linear pass surfaced each message once and DID
    // complete. The linear catalogue must win — the runaway branch stream
    // is a repetition, not a faithful play order.
    let branch_prompt = prompt(1, "spin-line");
    let linear_prompt = prompt(2, "catalogue-line");
    let spun_branch: Vec<TextLine> = (0..5_000).map(|_| line("spin-line")).collect();
    let (lines, prompts) = select_port_pass(
        spun_branch,
        vec![branch_prompt],
        PassTermination::BudgetExhausted,
        vec![line("catalogue-line")],
        vec![linear_prompt.clone()],
        PassTermination::NaturalTerminus,
    );
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].line_id, "catalogue-line");
    assert_eq!(prompts, vec![linear_prompt]);
}

#[test]
fn selected_port_pass_keeps_branch_when_neither_reaches_terminus() {
    // If even the linear pass did not complete there is no better stream to
    // fall back to, so the branch play order is retained (best available).
    let branch_prompt = prompt(1, "branch-line");
    let (lines, prompts) = select_port_pass(
        vec![line("branch-line")],
        vec![branch_prompt.clone()],
        PassTermination::BudgetExhausted,
        vec![line("linear-line")],
        vec![prompt(2, "linear-line")],
        PassTermination::BudgetExhausted,
    );
    assert_eq!(lines[0].line_id, "branch-line");
    assert_eq!(prompts, vec![branch_prompt]);
}

#[test]
fn selected_port_pass_keeps_distinct_budget_exhausted_branch_and_failures() {
    let distinct_branch: Vec<TextLine> = (0..5_000)
        .map(|i| line(&format!("distinct-line-{i}")))
        .collect();
    let (lines, _) = select_port_pass(
        distinct_branch,
        Vec::new(),
        PassTermination::BudgetExhausted,
        vec![line("linear-line")],
        Vec::new(),
        PassTermination::NaturalTerminus,
    );
    // Under the old `!branch_reached_terminus && linear_reached_terminus`
    // proxy this branch would be wrongly collapsed to linear; the
    // evidence-based detector keeps it because the lines are distinct (no
    // repetition).
    assert_eq!(lines.len(), 5_000);
    assert_eq!(lines[0].text, "distinct-line-0");
    assert_eq!(lines[4_999].text, "distinct-line-4999");

    for termination in [PassTermination::VmError, PassTermination::Suspended] {
        let (lines, _) = select_port_pass(
            vec![line("branch-failure")],
            Vec::new(),
            termination,
            vec![line("linear-line")],
            Vec::new(),
            PassTermination::NaturalTerminus,
        );
        assert_eq!(
            lines[0].text, "branch-failure",
            "{termination:?} must retain the branch stream"
        );
    }
}

#[test]
fn observe_for_port_uses_branch_stream_when_select_paths_diverge() {
    let engine = divergent_select_port_engine();
    let opts = ReplayOpts {
        step_budget: 128,
        stop_at_first_pause: false,
    };

    let observation = engine.observe_for_port(1, &opts);
    let branch_lines = engine.branch_following_lines(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert_eq!(
        observation.play_order_lines, branch_lines,
        "port observation must select the real AlwaysFirst branch stream"
    );

    let texts: Vec<&str> = observation
        .play_order_lines
        .iter()
        .map(|line| line.text.as_str())
        .collect();
    assert!(texts.contains(&"reaction from the first option"));
    assert!(
        !texts.contains(&"reaction from the second option"),
        "the linear catalogue's unchosen reaction must not leak into play order"
    );
}

#[test]
fn observe_for_port_falls_back_to_linear_catalogue_for_repeated_choice_prompt() {
    let engine = spinning_select_port_engine();
    let opts = ReplayOpts {
        step_budget: 192,
        stop_at_first_pause: false,
    };

    // Prove the branch side of the divergent scene genuinely fills its
    // budget with repeated prompt text. The assertion below then proves
    // observe_for_port selected the other, natural linear pass.
    let branch_lines = engine.branch_following_lines(1, &opts, HeadlessChoicePolicy::AlwaysFirst);
    assert!(
        branch_lines.len() >= 50,
        "branch must emit enough prompt lines to spin"
    );
    assert!(
        branch_lines
            .iter()
            .all(|line| { matches!(line.text.as_str(), "repeat first" | "repeat second") })
    );

    let observation = engine.observe_for_port(1, &opts);
    let texts: Vec<&str> = observation
        .play_order_lines
        .iter()
        .map(|line| line.text.as_str())
        .collect();
    assert_eq!(
        texts,
        vec![
            "repeat first",
            "repeat second",
            "linear first reaction",
            "linear second reaction",
        ],
        "a repeated branch prompt must fall back to the completed linear catalogue"
    );
}
