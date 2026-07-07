// Itotori Studio — the studio store.
// Models the human-in-the-loop workflow as real state and a legible handoff:
//   playtester FLAGS from the running build →
//   reviewer DECIDES each queued item (approve as-is / send back to fix) →
//   corrections queue for the next pass →
//   director LAUNCHES the pass → benchmark re-scores → confidence moves.
// Identity (who you're signed in as) sets both your home surface and what you
// may do; redaction is governed by the same identity.
const { createContext, useContext, useState, useRef, useCallback, useEffect } = React;

const StudioContext = createContext(null);
let _seq = 100;
const nextId = (p) => `${p}-${++_seq}`;

function StudioProvider({ children }) {
  const D = window.ItotoriData;

  // ── identity ──
  const [orgId, setOrgId] = useState("org-yoake");
  const [userId, setUserId] = useState("user-aoi");
  const currentUser = D.users.find((u) => u.id === userId) || D.users[0];
  const currentOrg = D.orgs.find((o) => o.id === orgId) || D.orgs[0];
  const caps = {
    label: currentUser.role,
    canFlag: currentUser.canFlag,
    canDecide: currentUser.canDecide,
    canSteer: currentUser.canSteer,
    canReveal: currentUser.canReveal,
  };

  // ── context ──
  const [projectId, setProjectId] = useState("proj-hoshimori-hd");
  const [branch, setBranch] = useState("en-US");
  const [view, setView] = useState(currentUser.home);
  const [currentSceneId, setCurrentSceneId] = useState("m-07");

  // ── redaction ──
  const [revealSensitive, setRevealSensitive] = useState(false);
  const [shareRedaction, setShareRedaction] = useState(false);

  // ── workflow state ──
  const [queue, setQueue] = useState(D.reviewQueue.map((i) => ({ ...i })));
  const [coverage, setCoverage] = useState(() => {
    const m = {};
    D.routes.forEach((r) =>
      r.items.forEach((it) => {
        m[it.id] = it.coverage || "needs_check";
      }),
    );
    return m;
  });
  const [stages, setStages] = useState({ ...D.localization.stages });
  const [cycle, setCycle] = useState({ ...D.localization.cycle });
  const [passIndex, setPassIndex] = useState(3);
  const [passes, setPasses] = useState(D.passes.map((p) => ({ ...p })));
  const [contestants, setContestants] = useState(D.benchmark.contestants.map((c) => ({ ...c })));
  const [confidence, setConfidence] = useState(D.benchmark.confidence);
  const [launching, setLaunching] = useState(false);
  const [toasts, setToasts] = useState([]);

  const timers = useRef([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  // ── derived ──
  const project = D.projects.find((p) => p.id === projectId);
  const work = D.works.find((w) => w.workId === project.workId);
  const edition = work.editions.find((e) => e.id === project.editionId);
  const total = D.localization.total;
  const needsReview = queue.filter((i) => i.status === "needs_review");
  const queuedForPass = queue.filter((i) => i.status === "queued");
  const resolvedItems = queue.filter((i) => i.status === "resolved");
  const selfScore = contestants.find((c) => c.kind === "self")?.score ?? 0;
  const scenesAll = D.routes.flatMap((r) => r.items);
  const validatedCount = scenesAll.filter((s) => coverage[s.id] === "validated").length;
  const flaggedScenes = scenesAll.filter((s) => coverage[s.id] === "flagged");

  const workIsAdult = work?.contentRating === "adult" || edition?.rating === "adult";
  const shouldBlur = useCallback(
    (sensitive) => {
      if (shareRedaction) return true;
      const isSensitive = sensitive || workIsAdult;
      if (!isSensitive) return false;
      return !(revealSensitive && caps.canReveal);
    },
    [shareRedaction, workIsAdult, revealSensitive, caps],
  );

  const pushToast = useCallback((message, tone = "neutral") => {
    const id = nextId("toast");
    setToasts((t) => [...t, { id, message, tone }]);
    const to = setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
    timers.current.push(to);
  }, []);

  // switching account signs you in as someone else → land on their home
  const switchUser = useCallback((id) => {
    const u = D.users.find((x) => x.id === id);
    setUserId(id);
    if (u) setView(u.home);
    if (u && !u.canReveal) setRevealSensitive(false);
  }, []);

  // ── playtester: flag from the running build ──
  const flagItem = useCallback(
    (f) => {
      const item = {
        id: nextId("rq"),
        kind: f.category === "layout" ? "runtime" : "playtest",
        sceneId: f.sceneId || currentSceneId,
        unit: f.unit || `bridge-unit:${f.sceneId || currentSceneId}-line`,
        speaker: f.speaker || "—",
        frame: f.frame,
        title: f.text || "Playtester flag",
        category: f.category || "tone",
        severity: f.severity || "warning",
        origin: "playtest",
        source: f.source || "—",
        draft: f.draft,
        proposal: f.proposal,
        note: f.text,
        status: "needs_review",
        fresh: true,
      };
      setQueue((q) => [item, ...q]);
      setCoverage((c) => ({ ...c, [item.sceneId]: "flagged" }));
      pushToast(`Flag sent to review · ${item.severity} · ${item.category}`, "neutral");
      return item;
    },
    [currentSceneId, pushToast],
  );

  const markValidated = useCallback(
    (sceneId) => {
      setCoverage((c) => ({ ...c, [sceneId]: "validated" }));
      pushToast("Scene marked validated.", "ok");
    },
    [pushToast],
  );

  // ── reviewer: decide an item ──
  const decideItem = useCallback(
    (id, action, payload) => {
      if (!caps.canDecide) {
        pushToast("Deciding review items needs a reviewer or director.", "critical");
        return;
      }
      if (action === "approve") {
        setQueue((q) =>
          q.map((i) =>
            i.id === id ? { ...i, status: "resolved", resolution: "approved", fresh: false } : i,
          ),
        );
        setStages((s) => ({
          ...s,
          translated: Math.max(0, s.translated - 8),
          proven: s.proven + 8,
        }));
        pushToast("Approved as-is — unit marked proven.", "ok");
      } else if (action === "queue") {
        setQueue((q) =>
          q.map((i) =>
            i.id === id
              ? {
                  ...i,
                  status: "queued",
                  resolution: "correction",
                  correction: payload,
                  fresh: false,
                }
              : i,
          ),
        );
        pushToast(`Correction queued for pass ${passIndex + 1}.`, "neutral");
      }
    },
    [caps, passIndex, pushToast],
  );

  // ── director: launch the next pass (folds every queued correction) ──
  const launchPass = useCallback(() => {
    if (!caps.canSteer) {
      pushToast("Only the director can launch a pass.", "critical");
      return;
    }
    const queued = queue.filter((i) => i.status === "queued");
    if (queued.length === 0 || launching) return;
    const nextPass = passIndex + 1;
    setLaunching(true);
    pushToast(
      `Pass ${nextPass} started — re-drafting ${queued.length} corrected ${queued.length === 1 ? "unit" : "units"}…`,
      "neutral",
    );
    const to = setTimeout(() => {
      setQueue((q) =>
        q.map((i) =>
          i.status === "queued" ? { ...i, status: "resolved", resolution: "repaired" } : i,
        ),
      );
      setStages((s) => {
        const moveA = Math.min(40, s.translated);
        const moveB = Math.min(30, s.revised + moveA);
        return {
          translated: s.translated - moveA,
          qa: s.qa,
          revised: s.revised + moveA - moveB,
          proven: s.proven + moveB,
        };
      });
      setCycle((c) => ({ ...c, current: Math.min(c.of, c.current + 1) }));
      setPassIndex(nextPass);
      setContestants((list) =>
        list.map((c) =>
          c.kind === "self"
            ? {
                ...c,
                name: `Itotori (pass ${nextPass})`,
                score: Math.round((c.score + 0.15) * 100) / 100,
                wins: c.wins + 6,
                losses: Math.max(0, c.losses - 3),
              }
            : c,
        ),
      );
      setPasses((list) => {
        const prev = list[list.length - 1].score;
        const newScore = Math.round((prev + 0.15) * 100) / 100;
        return [
          ...list.map((p) => ({ ...p, current: false })),
          {
            pass: nextPass,
            score: newScore,
            feedback: queued.length,
            note: `Folded in ${queued.length} human ${queued.length === 1 ? "correction" : "corrections"} from review.`,
            current: true,
          },
        ];
      });
      setContestants((list) => {
        const self = list.find((c) => c.kind === "self");
        if (self && self.score >= D.benchmark.humanAnchor) {
          setConfidence("strong_caliber");
          pushToast(`Pass ${nextPass} scored ${self.score} — strong-caliber reached.`, "ok");
        } else pushToast(`Pass ${nextPass} landed — benchmark re-scored.`, "ok");
        return list;
      });
      setLaunching(false);
    }, 2000);
    timers.current.push(to);
  }, [caps, queue, passIndex, launching, pushToast]);

  const dismissToast = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const value = {
    D,
    org: currentOrg,
    orgs: D.orgs,
    orgId,
    setOrgId,
    project,
    work,
    edition,
    projectId,
    setProjectId,
    branch,
    setBranch,
    view,
    setView,
    currentSceneId,
    setCurrentSceneId,
    users: D.users,
    currentUser,
    userId,
    switchUser,
    caps,
    revealSensitive,
    setRevealSensitive,
    shareRedaction,
    setShareRedaction,
    shouldBlur,
    workIsAdult,
    total,
    stages,
    cycle,
    passIndex,
    passes,
    contestants,
    confidence,
    selfScore,
    launching,
    queue,
    needsReview,
    queuedForPass,
    resolvedItems,
    coverage,
    scenesAll,
    validatedCount,
    flaggedScenes,
    flagItem,
    markValidated,
    decideItem,
    launchPass,
    toasts,
    pushToast,
    dismissToast,
  };
  return React.createElement(StudioContext.Provider, { value }, children);
}

function useStudio() {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error("useStudio must be used inside StudioProvider");
  return ctx;
}

Object.assign(window, { StudioProvider, useStudio });
