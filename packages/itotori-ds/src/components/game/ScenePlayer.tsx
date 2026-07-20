import type { ReactNode } from "react";
import { cx } from "../../cx.js";
import { Badge } from "../core/Badge.js";
import { BiText } from "../localization/BiText.js";

export type ScenePlayerMode = "play" | "review";

export interface ScenePlayerProps {
  /** Game-agnostic scene/unit identifier rendered as a machine token. */
  unitId: string;
  /** Play mode is for browsing; review mode is for evidence / QA passback. */
  mode?: ScenePlayerMode;
  /** Optional source/draft text shown in the VN textbox layer. */
  sourceText?: string | null;
  translationText?: string | null;
  sourceLocale?: string;
  targetLocale?: string;
  /** Optional speaker/nameplate. */
  speaker?: ReactNode;
  /** Current frame/media slot supplied by the host surface. */
  frame?: ReactNode;
  /** Status badge vocabulary: running, captured, runtime-faithful, stale, etc. */
  status?: string | null;
  /** Bring the rendered unit forward after an addressable navigation. */
  highlighted?: boolean;
  /** Optional review/annotation slot, usually AnnotationComposer. */
  annotation?: ReactNode;
  previousLabel?: string;
  nextLabel?: string;
  onPrevious?: () => void;
  onNext?: () => void;
  className?: string;
}

/**
 * ScenePlayer — the design-system VN player shell.
 *
 * The host owns runtime data, media, and navigation behavior; this component
 * only provides the reusable Dusk Observatory frame, source-first text layer,
 * status vocabulary, and accessible previous/next controls.
 */
export function ScenePlayer({
  unitId,
  mode = "play",
  sourceText = null,
  translationText = null,
  sourceLocale,
  targetLocale,
  speaker,
  frame,
  status = null,
  highlighted = false,
  annotation,
  previousLabel = "Previous scene",
  nextLabel = "Next scene",
  onPrevious,
  onNext,
  className,
}: ScenePlayerProps): ReactNode {
  const hasText =
    (sourceText !== null && sourceText.length > 0) ||
    (translationText !== null && translationText.length > 0);

  return (
    <section
      className={cx(
        "itotori-scene-player",
        highlighted && "itotori-scene-player--highlighted",
        className,
      )}
      data-component="scene-player"
      data-mode={mode}
      aria-current={highlighted ? "true" : undefined}
      aria-label="Scene player"
    >
      <div className="itotori-scene-player__chrome">
        <div className="itotori-scene-player__title">
          <span className="itotori-scene-player__eyebrow">{mode}</span>
          <code className="itotori-scene-player__unit">{unitId}</code>
          {status !== null && <Badge status={status}>{status}</Badge>}
        </div>
        <div className="itotori-scene-player__controls" aria-label="Scene controls">
          <button
            type="button"
            className="itotori-scene-player__control"
            aria-label={previousLabel}
            disabled={onPrevious === undefined}
            onClick={onPrevious}
          >
            ◀
          </button>
          <button
            type="button"
            className="itotori-scene-player__control"
            aria-label={nextLabel}
            disabled={onNext === undefined}
            onClick={onNext}
          >
            ▶
          </button>
        </div>
      </div>

      <div className="itotori-scene-player__stage itotori-frame itotori-scanlines">
        <div className="itotori-scene-player__frame">
          {frame ?? <div className="itotori-scene-player__placeholder">No frame captured</div>}
        </div>
        {hasText && (
          <div className="itotori-scene-player__textbox" data-role="textbox">
            <BiText
              source={sourceText ?? ""}
              translation={translationText ?? ""}
              {...(sourceLocale !== undefined ? { sourceLocale } : {})}
              {...(targetLocale !== undefined ? { targetLocale } : {})}
              speaker={speaker}
            />
          </div>
        )}
      </div>

      {annotation !== undefined && (
        <div className="itotori-scene-player__annotation" data-role="annotation">
          {annotation}
        </div>
      )}
    </section>
  );
}
