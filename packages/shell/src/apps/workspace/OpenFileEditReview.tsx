import { useEffect, useRef, useState } from "react";
import { t } from "../../lib/i18n";
import {
  OPEN_FILE_EDIT_APPROVAL_TIMEOUT_MS,
  type OpenFileEditProposal,
} from "./open-file-edit";

export interface OpenFileEditReviewProps {
  proposal: OpenFileEditProposal;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

export function OpenFileEditReview({
  proposal,
  onApprove,
  onReject,
}: OpenFileEditReviewProps) {
  const rejectButtonRef = useRef<HTMLButtonElement>(null);

  const [secondsRemaining, setSecondsRemaining] = useState(() => {
    if (typeof proposal.expiresAt !== "number") {
      return Math.ceil(
        (proposal.timeoutMs ?? OPEN_FILE_EDIT_APPROVAL_TIMEOUT_MS) / 1000,
      );
    }
    return Math.max(0, Math.ceil((proposal.expiresAt - Date.now()) / 1000));
  });

  useEffect(() => {
    rejectButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const compute = () => {
      if (typeof proposal.expiresAt !== "number") {
        return Math.ceil(
          (proposal.timeoutMs ?? OPEN_FILE_EDIT_APPROVAL_TIMEOUT_MS) / 1000,
        );
      }
      return Math.max(0, Math.ceil((proposal.expiresAt - Date.now()) / 1000));
    };
    setSecondsRemaining(compute());
    const timer = setInterval(() => {
      setSecondsRemaining(compute());
    }, 1000);
    return () => clearInterval(timer);
  }, [proposal.expiresAt, proposal.timeoutMs]);

  const fileName =
    proposal.path.split(/[/\\]/).filter(Boolean).pop() ?? proposal.path;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onReject(proposal.id);
    }
  };

  return (
    <section
      aria-label={t("workspace.aiEdit.title")}
      data-testid="open-file-edit-review"
      className="open-file-edit-review"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <header className="open-file-edit-review__header">
        <div className="open-file-edit-review__meta">
          <h4 className="open-file-edit-review__title">
            {t("workspace.aiEdit.title")}
          </h4>
          <span
            className="open-file-edit-review__filename"
            title={proposal.path}
          >
            {fileName}
          </span>
          <span className="open-file-edit-review__counts">
            +{proposal.added} −{proposal.removed}
          </span>
        </div>
        <div
          data-testid="open-file-edit-countdown"
          role="timer"
          aria-live="off"
          className="open-file-edit-review__countdown"
        >
          {t("workspace.aiEdit.countdown", { seconds: secondsRemaining })}
        </div>
        {proposal.summary && (
          <div className="open-file-edit-review__summary">
            {proposal.summary}
          </div>
        )}
      </header>

      <pre
        data-testid="open-file-edit-diff"
        className="open-file-edit-review__diff"
      >
        {proposal.lines.map((line, idx) => {
          const prefix =
            line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  ";
          return (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity; the list is replaced as a whole per proposal
              key={idx}
              className={`open-file-edit-review__line open-file-edit-review__line--${line.kind} open-file-edit-review-line-${line.kind}`}
            >
              {prefix}
              {line.text}
              {"\n"}
            </span>
          );
        })}
      </pre>

      {proposal.truncated && (
        <div className="open-file-edit-review__truncated">
          {t("workspace.aiEdit.truncated")}
        </div>
      )}

      <footer className="open-file-edit-review__actions">
        <button
          type="button"
          data-testid="open-file-edit-approve"
          className="open-file-edit-review__btn open-file-edit-review__btn--approve"
          onClick={() => onApprove(proposal.id)}
        >
          {t("workspace.aiEdit.approve")}
        </button>
        <button
          type="button"
          ref={rejectButtonRef}
          data-testid="open-file-edit-reject"
          className="open-file-edit-review__btn open-file-edit-review__btn--reject"
          onClick={() => onReject(proposal.id)}
        >
          {t("workspace.aiEdit.reject")}
        </button>
      </footer>
    </section>
  );
}
