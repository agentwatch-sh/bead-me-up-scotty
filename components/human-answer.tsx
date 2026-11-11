"use client";
import * as React from "react";
import { HumanQuestionnaire } from "@/components/human-questionnaire";
import { useApp } from "@/components/app-context";
import { Icon } from "@/components/icons";
import { ClosedMeanwhile, failedDraft, useAnswerOutbox, type AnswerRoute } from "@/components/answer-outbox";
import { HUMAN_KINDS, failureFor, type OutboxKind } from "@/lib/answer-outbox";
import { api, humanBody } from "@/lib/api-client";
import { parseQuestions, parseChoices, renderChoice, isMultiSelect, renderSelection, type HumanChoice } from "@/lib/human-choices";
import type { HumanBody } from "@/lib/human-validate";
import type { Bead } from "@/lib/schema";

/** Shared answer controls for the inbox and item detail. */
export function HumanAnswer({ bead, route, disabled }: { bead: Bead; route?: AnswerRoute; disabled?: boolean }) {
  const questions = parseQuestions(bead.metadata?.["scotty.choices"]);
  return questions ? <HumanQuestionnaire key={bead.id} bead={bead} initialQuestions={questions} route={route} disabled={disabled} /> : <SingleHumanAnswer key={bead.id} bead={bead} route={route} disabled={disabled} />;
}

/** What the form held when it sent; a failed write brings it back. */
type SingleDraft = { text: string; selected: HumanChoice[] };
const isSingleDraft = (draft: unknown): draft is SingleDraft =>
  !!draft && typeof draft === "object" && typeof (draft as SingleDraft).text === "string" && Array.isArray((draft as SingleDraft).selected);

function SingleHumanAnswer({ bead, route, disabled: held }: { bead: Bead; route?: AnswerRoute; disabled?: boolean }) {
  const { readOnly, projectId } = useApp();
  const outbox = useAnswerOutbox();
  const entry = outbox.entry(bead.id);
  // The item leaves its list at the click (the answer outbox); a failed write
  // brings it back here with its error and what was typed. Only a failure of
  // this form's own kind shows here (an Accept's error never shows in a Reverse).
  const failed = failureFor(entry, route ? [route.kind] : HUMAN_KINDS);
  const restored = failedDraft(failed, isSingleDraft);
  const [selected, setSelected] = React.useState<HumanChoice[]>(() => restored?.selected ?? []);
  const selectedIds = selected.map((choice) => choice.id);
  const [text, setText] = React.useState(() => restored?.text ?? "");
  // An edit deals with the failure: its error goes.
  const edited = () => { if (failed) outbox.clear(bead.id); };
  const options = parseChoices(bead.metadata?.["scotty.choices"]);
  const multiSelect = isMultiSelect(bead.metadata?.["scotty.choices"]);
  const recommended: HumanChoice | undefined = options ? { version: 1, ...options[0] } : undefined;
  // With a route the item is closed on purpose (a Reverse answers a closed item).
  const disabled = readOnly || !!held || entry?.state === "sending" || (!route && bead.status === "closed");
  const errorMessage = failed?.error ?? null;
  // What the person typed goes with every answer: a tapped option, the selections, Dismiss.
  const note = text.trim() || undefined;
  // Each action goes to the route when there is one, else to the human route.
  const send = (kind: OutboxKind, body: HumanBody) => void outbox.send({
    id: bead.id,
    kind: route?.kind ?? kind,
    // The click's id goes with the answer; a retry of the same answer keeps it, so the board writes it once.
    request: (signal, clickId) => (route ? route.request(body, signal, clickId)
      : api.human.answer(projectId, bead.id, { ...body, click_id: clickId }, signal)),
    fingerprint: JSON.stringify(body),
    draft: { text, selected } satisfies SingleDraft,
    warning: route?.warning,
  });
  const sendRespond = (text: string, choice?: HumanChoice, choices?: HumanChoice[], note?: string) =>
    send("respond", humanBody.respond(text, choice, choices, note));
  const sendDecline = (text: string) => send("decline", humanBody.decline(text));
  const sendDismiss = () => send("dismiss", humanBody.dismiss(recommended, note));
  // The review route refuses a Dismiss with no option to record.
  const showDismiss = !route || !!recommended;

  return (
    <div data-human-answer={bead.id} className="min-w-0">
      {multiSelect && <p className="mb-2 text-[12px] text-[var(--text-2)]">Select options, then press Respond. Or write an answer below.</p>}
      {!multiSelect && options && note && <p className="mb-2 text-[12px] text-[var(--text-3)]">Your comment goes with the option you tap.</p>}
      {options && (
        <div role="group" aria-label="Answer choices" className="mb-3 flex flex-col gap-2">
          {options.map((option) => {
            const choice: HumanChoice = { version: 1, ...option };
            return (
              <button key={option.id} type="button" disabled={disabled}
                style={multiSelect && selectedIds.includes(option.id) ? { borderColor: "var(--brand)", boxShadow: "0 0 0 1px var(--brand)" } : undefined}
                aria-pressed={multiSelect ? selectedIds.includes(option.id) : undefined}
                onClick={() => multiSelect
                  ? (edited(), setSelected((previous) => previous.some((item) => item.id === option.id) ? previous.filter((item) => item.id !== option.id) : [...previous, choice]))
                  : sendRespond(renderChoice(choice, note), choice, undefined, note)}
                className="w-full rounded-lg border border-border bg-[var(--surface-2)] p-3 text-left whitespace-normal break-words hover:border-[var(--brand)] focus-visible:outline-2 focus-visible:outline-[var(--brand)] disabled:opacity-50">
                <span className="flex flex-wrap items-center gap-2 text-[13px] font-[600]">
                  {multiSelect && selectedIds.includes(option.id) && <span aria-hidden="true">✓</span>}
                  {option.label}
                  {option.recommended && <span className="rounded bg-[var(--brand)] px-2 py-0.5 text-[11px] text-white">Recommended</span>}
                </span>
                <span className="mt-1 block text-[12px] text-[var(--text-2)]">{option.description}</span>
              </button>
            );
          })}
        </div>
      )}
      <textarea disabled={disabled} value={text} onChange={(e) => { edited(); setText(e.target.value); }} rows={2}
        aria-label="Write an answer"
        placeholder={options ? "Answer the agent's question, or add a comment to your choice… (closes the item)" : "Answer the agent's question… (posts a comment and closes the item)"}
        className="mb-2 w-full resize-y rounded-[9px] border border-border bg-[var(--surface-2)] p-[9px_11px] text-[13px] leading-[1.5] text-[var(--text)] outline-none focus:border-[var(--brand)]" />
      <p className="mb-2 text-[12px] text-[var(--text-3)]">To decline the question, write your reason above and press Decline question.</p>
      {errorMessage && <p role="alert" className="mb-2 text-[12px] text-red-500">{errorMessage}</p>}
      <ClosedMeanwhile bead={bead} failed={!!failed} route={route} />
      {multiSelect && note && selected.length > 0 && <p className="mb-2 text-[12px] text-[var(--text-3)]">Respond sends the selected options with your comment.</p>}
      {recommended && <p className="mb-2 text-[12px] text-[var(--text-3)]">Dismiss uses: {recommended.label}.{note ? " Your comment goes with it." : ""}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" disabled={disabled || !text.trim()} onClick={() => sendDecline(text.trim())}
          className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text-2)] hover:bg-[var(--surface-3)] disabled:opacity-50">Decline question</button>
        {showDismiss && <button type="button" disabled={disabled} onClick={sendDismiss}
          className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text-2)] hover:bg-[var(--surface-3)] disabled:opacity-50">Dismiss</button>}
        <button type="button" disabled={disabled || (!note && selected.length === 0)} onClick={() => selected.length
          ? sendRespond(renderSelection(selected, note), undefined, selected, note)
          : sendRespond(text.trim())}
          className="flex h-8 items-center gap-[6px] rounded-lg bg-[var(--brand)] px-3 text-[12.5px] font-[550] text-white disabled:opacity-50">
          <Icon name="check" size={14} /> Respond
        </button>
      </div>
    </div>
  );
}
