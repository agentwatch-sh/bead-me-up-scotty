"use client";
import * as React from "react";
import { HumanQuestionnaire } from "@/components/human-questionnaire";
import { useApp } from "@/components/app-context";
import { Icon } from "@/components/icons";
import { useRespondHuman, useDismissHuman, useDeclineHuman } from "@/hooks/use-beads";
import { useAnswerSubmit, type AnswerSubmit } from "@/hooks/use-answer-submit";
import { humanBody } from "@/lib/api-client";
import { parseQuestions, parseChoices, renderChoice, isMultiSelect, renderSelection, type HumanChoice } from "@/lib/human-choices";
import type { Bead } from "@/lib/schema";

/** Shared answer controls for the inbox and item detail. */
export function HumanAnswer({ bead, submit, disabled }: { bead: Bead; submit?: AnswerSubmit; disabled?: boolean }) {
  const questions = parseQuestions(bead.metadata?.["scotty.choices"]);
  return questions ? <HumanQuestionnaire key={bead.id} bead={bead} initialQuestions={questions} submit={submit} disabled={disabled} /> : <SingleHumanAnswer key={bead.id} bead={bead} submit={submit} disabled={disabled} />;
}

function SingleHumanAnswer({ bead, submit, disabled: held }: { bead: Bead; submit?: AnswerSubmit; disabled?: boolean }) {
  const { readOnly } = useApp();
  const respond = useRespondHuman();
  const dismiss = useDismissHuman();
  const decline = useDeclineHuman();
  const override = useAnswerSubmit(submit);
  const [selected, setSelected] = React.useState<HumanChoice[]>([]);
  const selectedIds = selected.map((choice) => choice.id);
  const [text, setText] = React.useState("");
  const options = parseChoices(bead.metadata?.["scotty.choices"]);
  const multiSelect = isMultiSelect(bead.metadata?.["scotty.choices"]);
  const recommended: HumanChoice | undefined = options ? { version: 1, ...options[0] } : undefined;
  // With an override the item is closed on purpose (a Reverse answers a closed item).
  const disabled = readOnly || !!held || override.pending || respond.isPending || dismiss.isPending || decline.isPending || (!submit && bead.status === "closed");
  const error = respond.error || dismiss.error || decline.error;
  const errorMessage = override.error ?? (error instanceof Error ? error.message : error ? "The answer could not be saved." : null);
  // Each action goes to the override when there is one, else to the human route.
  const sendRespond = (text: string, choice?: HumanChoice, choices?: HumanChoice[]) => submit
    ? override.run(humanBody.respond(text, choice, choices))
    : respond.mutate({ id: bead.id, text, choice, choices });
  const sendDecline = (text: string) => submit ? override.run(humanBody.decline(text)) : decline.mutate({ id: bead.id, text });
  const sendDismiss = () => submit
    ? override.run(humanBody.dismiss(recommended))
    : dismiss.mutate({ id: bead.id, choice: recommended });
  // The review route refuses a Dismiss with no option to record.
  const showDismiss = !submit || !!recommended;

  return (
    <div data-human-answer={bead.id} className="min-w-0">
      {multiSelect && <p className="mb-2 text-[12px] text-[var(--text-2)]">Select options, then press Respond. Or write an answer below.</p>}
      {options && (
        <div role="group" aria-label="Answer choices" className="mb-3 flex flex-col gap-2">
          {options.map((option) => {
            const choice: HumanChoice = { version: 1, ...option };
            return (
              <button key={option.id} type="button" disabled={disabled}
                style={multiSelect && selectedIds.includes(option.id) ? { borderColor: "var(--brand)", boxShadow: "0 0 0 1px var(--brand)" } : undefined}
                aria-pressed={multiSelect ? selectedIds.includes(option.id) : undefined}
                onClick={() => multiSelect
                  ? setSelected((previous) => previous.some((item) => item.id === option.id) ? previous.filter((item) => item.id !== option.id) : [...previous, choice])
                  : sendRespond(renderChoice(choice), choice)}
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
      <textarea disabled={disabled} value={text} onChange={(e) => setText(e.target.value)} rows={2}
        aria-label="Write an answer"
        placeholder="Answer the agent's question… (posts a comment and closes the item)"
        className="mb-2 w-full resize-y rounded-[9px] border border-border bg-[var(--surface-2)] p-[9px_11px] text-[13px] leading-[1.5] text-[var(--text)] outline-none focus:border-[var(--brand)]" />
      <p className="mb-2 text-[12px] text-[var(--text-3)]">To decline the question, write your reason above and press Decline question.</p>
      {errorMessage && <p role="alert" className="mb-2 text-[12px] text-red-500">{errorMessage}</p>}
      {multiSelect && text.trim() && selected.length > 0 && <p className="mb-2 text-[12px] text-[var(--text-3)]">Respond sends your written answer. Clear it to send the selected options.</p>}
      {recommended && <p className="mb-2 text-[12px] text-[var(--text-3)]">Dismiss uses: {recommended.label}.</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" disabled={disabled || !text.trim()} onClick={() => sendDecline(text.trim())}
          className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text-2)] hover:bg-[var(--surface-3)] disabled:opacity-50">Decline question</button>
        {showDismiss && <button type="button" disabled={disabled} onClick={sendDismiss}
          className="h-8 rounded-lg border border-border bg-[var(--surface-2)] px-3 text-[12.5px] font-[550] text-[var(--text-2)] hover:bg-[var(--surface-3)] disabled:opacity-50">Dismiss</button>}
        <button type="button" disabled={disabled || (!text.trim() && selected.length === 0)} onClick={() => selected.length && !text.trim()
          ? sendRespond(renderSelection(selected), undefined, selected)
          : sendRespond(text.trim())}
          className="flex h-8 items-center gap-[6px] rounded-lg bg-[var(--brand)] px-3 text-[12.5px] font-[550] text-white disabled:opacity-50">
          <Icon name="check" size={14} /> Respond
        </button>
      </div>
    </div>
  );
}
