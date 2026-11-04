"use client";
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useApp } from "@/components/app-context";
import { HumanAnswer } from "@/components/human-answer";
import type { AnswerSubmit } from "@/hooks/use-answer-submit";
import { Icon } from "@/components/icons";
import { toastError } from "@/components/error-toast";
import { api } from "@/lib/api-client";
import { relTime, fmtDateTime } from "@/lib/beads-view";
import { parseChoice, parseChoices, parseDecline, parseGroup, parseQuestions, parseSelection } from "@/lib/human-choices";
import { managerAnswer, needsReview, REVIEW_REASON_KEY } from "@/lib/review";
import { useAcceptReview, useCommentReview, useReverseReview, beadsKey } from "@/hooks/use-beads";
import type { Bead } from "@/lib/schema";

/** What the manager answered, as a person reads it. */
function answerText(bead: Bead, text: string | undefined): string {
  if (!text) {
    if (bead.close_reason !== "Dismissed") return "No answer text";
    // A dismissal writes no comment; it took the recommended option. Name it only when the options parse.
    const options = parseChoices(bead.metadata?.["scotty.choices"]);
    if (options) return `Dismissed (${options.find((o) => o.recommended)?.label ?? options[0].label})`;
    return parseQuestions(bead.metadata?.["scotty.choices"]) ? "Dismissed (the recommended option for each question)" : "Dismissed";
  }
  const choice = parseChoice(text);
  if (choice) return choice.label;
  const selection = parseSelection(text);
  if (selection) return selection.map((c) => c.label).join("; ");
  const declined = parseDecline(text);
  if (declined !== null) return `Declined: ${declined}`;
  const group = parseGroup(text);
  if (group) {
    return group.map((a) => `${a.header}: ${a.action === "declined" ? `Declined: ${a.text}` : a.choices ? a.choices.map((c) => c.label).join("; ") : a.text}`).join("\n");
  }
  return text;
}

/** The board user's comments made after the close: comments on the answer, not the answer. */
function commentsAfterClose(bead: Bead, actor: string) {
  const closedAt = bead.closed_at ? Date.parse(bead.closed_at) : NaN;
  if (Number.isNaN(closedAt)) return [];
  return (bead.comments ?? []).filter((c) => {
    const at = c.created_at ? Date.parse(c.created_at) : NaN;
    return c.author === actor && !Number.isNaN(at) && at > closedAt;
  });
}

/**
 * "To Review": answers a manager gave for you. The question is already closed,
 * so nothing here blocks the agent. Accept keeps the answer; Reverse replaces
 * it with yours; Comment sends your manager a comment and keeps the answer
 * here. Nothing leaves by itself.
 */
export function ToReviewView() {
  const { beads, meta, projectId, readOnly } = useApp();
  const qc = useQueryClient();
  const actor = meta?.humanActor ?? "you";
  const rows = React.useMemo(
    () => beads.filter((b) => needsReview(b, actor)).sort((a, b) => Date.parse(b.closed_at ?? "") - Date.parse(a.closed_at ?? "") || 0),
    [beads, actor],
  );
  const [busy, setBusy] = React.useState(false);
  // Rows with a request running, or a Reverse or Comment panel open. Accept all waits for them.
  const [held, setHeld] = React.useState<ReadonlySet<string>>(new Set());
  const hold = React.useCallback((id: string, on: boolean) => {
    setHeld((previous) => {
      if (previous.has(id) === on) return previous;
      const next = new Set(previous);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  const [bulkError, setBulkError] = React.useState<string | null>(null);

  const acceptAll = async () => {
    if (readOnly || busy || held.size > 0 || rows.length === 0) return;
    if (!confirm(`Accept all ${rows.length} answers?`)) return;
    setBusy(true);
    setBulkError(null);
    try {
      // One request per item, so each review is its own record.
      for (const row of rows) await api.review.accept(projectId, row.id);
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : "Accept all stopped.");
      toastError(e);
    } finally {
      await qc.invalidateQueries({ queryKey: beadsKey(projectId) });
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-6 py-4">
        <Icon name="check" size={18} className="text-[var(--text-2)]" />
        <h1 className="text-[15px] font-[650]">To Review</h1>
        <span className="text-[12px] text-[var(--text-3)]">
          · {rows.length === 0 ? "nothing to review" : `${rows.length} ${rows.length === 1 ? "answer" : "answers"} by your manager`}
        </span>
        <span className="flex-1" />
        {rows.length > 0 && (
          <button
            type="button"
            disabled={readOnly || busy || held.size > 0}
            onClick={acceptAll}
            className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text-2)] hover:bg-[var(--surface-3)] disabled:opacity-50"
          >
            Accept all ({rows.length})
          </button>
        )}
      </div>
      {bulkError && <p role="alert" className="px-6 pt-2 text-[12px] text-red-500">{bulkError}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {rows.length === 0 ? (
          <div className="p-10 text-center text-[13px] text-[var(--text-3)]">
            Nothing to review. When your manager answers an agent&apos;s question for you, the answer shows here until you accept or reverse it.
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {rows.map((b) => (
              <ReviewRow key={b.id} bead={b} actor={actor} disabled={busy} onHold={hold} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewRow({ bead, actor, disabled: bulkBusy, onHold }: { bead: Bead; actor: string; disabled: boolean; onHold: (id: string, on: boolean) => void }) {
  const { readOnly, openDetail } = useApp();
  const accept = useAcceptReview();
  const reverse = useReverseReview();
  const comment = useCommentReview();
  const [reversing, setReversing] = React.useState(false);
  const [commenting, setCommenting] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const holding = reversing || commenting || accept.isPending || reverse.isPending || comment.isPending;
  React.useEffect(() => {
    onHold(bead.id, holding);
    return () => onHold(bead.id, false);
  }, [bead.id, holding, onHold]);
  const answer = managerAnswer(bead, actor);
  const reason = bead.metadata?.[REVIEW_REASON_KEY];
  const questions = parseQuestions(bead.metadata?.["scotty.choices"]);
  const options = questions ? null : parseChoices(bead.metadata?.["scotty.choices"]);
  const disabled = readOnly || bulkBusy || accept.isPending || reverse.isPending || comment.isPending;
  const acceptError = accept.error instanceof Error ? accept.error.message : null;
  const commentError = comment.error instanceof Error ? comment.error.message : null;
  const submit: AnswerSubmit = (body) => reverse.mutateAsync({ id: bead.id, answer: body });
  const mine = commentsAfterClose(bead, actor);
  const sendComment = () => {
    const text = draft.trim();
    if (!text || disabled) return;
    // A plain comment: no verdict, so the row stays. What was typed stays on a failure.
    comment.mutate({ id: bead.id, text }, {
      onSuccess: () => {
        setDraft("");
        setCommenting(false);
      },
    });
  };

  return (
    <div data-review-row={bead.id} className="min-w-0 rounded-[12px] border border-border bg-[var(--surface)] p-4">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => openDetail(bead.id)} className="font-mono text-[11px] text-[var(--text-3)] hover:text-[var(--text)]">
          {bead.id}
        </button>
        <span className="flex-1" />
        <span title={fmtDateTime(bead.closed_at)} className="text-[11px] text-[var(--text-3)]">{relTime(bead.closed_at)}</span>
      </div>
      <button type="button" onClick={() => openDetail(bead.id)} className="mb-2 block max-w-full break-words text-left text-[14px] font-[600] leading-snug hover:underline">
        {bead.title}
      </button>
      {options && (
        <p className="mb-2 break-words text-[12px] text-[var(--text-3)]">Options: {options.map((o) => o.label).join(" · ")}</p>
      )}
      {questions && (
        <ul className="mb-2 list-disc pl-5 text-[12px] text-[var(--text-3)]">
          {questions.map((q) => <li key={q.id} className="break-words">{q.header}: {q.question}</li>)}
        </ul>
      )}
      <dl className="mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
        <dt className="text-[var(--text-3)]">Manager&apos;s answer</dt>
        <dd className="min-w-0 whitespace-pre-wrap break-words font-[600]">{answerText(bead, answer?.text)}</dd>
        <dt className="text-[var(--text-3)]">Why</dt>
        <dd className="min-w-0 whitespace-pre-wrap break-words text-[var(--text-2)]">{typeof reason === "string" && reason ? reason : "No reason given"}</dd>
        <dt className="text-[var(--text-3)]">Asked by</dt>
        <dd className="min-w-0 break-words text-[var(--text-2)]">{bead.created_by || "unknown"}</dd>
        {mine.length > 0 && (
          <>
            <dt className="text-[var(--text-3)]">{mine.length === 1 ? "Your comment" : "Your comments"}</dt>
            <dd className="min-w-0 text-[var(--text-2)]">
              <ul data-review-comments={bead.id} className="flex flex-col gap-1">
                {mine.map((c, i) => (
                  <li key={c.id ?? i} title={fmtDateTime(c.created_at)} className="whitespace-pre-wrap break-words">{c.text}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      {acceptError && <p role="alert" className="mb-2 text-[12px] text-red-500">{acceptError}</p>}
      {reversing ? (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-3 text-[12px] text-[var(--text-2)]">Your answer replaces the manager&apos;s. The asking agent gets it as a new answer from you.</p>
          <HumanAnswer bead={bead} submit={submit} disabled={bulkBusy} />
          <div className="mt-2 flex justify-end">
            <button type="button" disabled={disabled} onClick={() => setReversing(false)} className="h-8 rounded-lg border border-border px-3 text-[12.5px] disabled:opacity-50">
              Cancel
            </button>
          </div>
        </div>
      ) : commenting ? (
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 text-[12px] text-[var(--text-2)]">Your comment goes to your manager. The answer stays here until you accept or reverse it.</p>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} disabled={disabled}
            aria-label="Write a comment" placeholder="Comment on the manager's answer…"
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendComment(); } }}
            className="mb-2 w-full resize-y rounded-[9px] border border-border bg-[var(--surface-2)] p-[9px_11px] text-[13px] leading-[1.5] text-[var(--text)] outline-none focus:border-[var(--brand)]" />
          {commentError && <p role="alert" className="mb-2 text-[12px] text-red-500">{commentError}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" disabled={comment.isPending} onClick={() => { setCommenting(false); comment.reset(); }}
              className="h-8 rounded-lg border border-border px-3 text-[12.5px] disabled:opacity-50">
              Cancel
            </button>
            <button type="button" disabled={disabled || !draft.trim()} onClick={sendComment}
              className="h-8 rounded-lg bg-[var(--brand)] px-3 text-[12.5px] font-[550] text-white disabled:opacity-50">
              Send
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button type="button" disabled={disabled} onClick={() => { comment.reset(); setCommenting(true); }}
            className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text-2)] hover:bg-[var(--surface-3)] disabled:opacity-50">
            Comment
          </button>
          <button type="button" disabled={disabled} onClick={() => setReversing(true)}
            className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text-2)] hover:bg-[var(--surface-3)] disabled:opacity-50">
            Reverse
          </button>
          <button type="button" disabled={disabled} onClick={() => accept.mutate({ id: bead.id })}
            className="flex h-8 items-center gap-[6px] rounded-lg bg-[var(--brand)] px-3 text-[12.5px] font-[550] text-white disabled:opacity-50">
            <Icon name="check" size={14} /> Accept
          </button>
        </div>
      )}
    </div>
  );
}
