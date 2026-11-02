"use client";
import * as React from "react";
import { useApp } from "@/components/app-context";
import { useSubmitQuestions } from "@/hooks/use-beads";
import { useAnswerSubmit, type AnswerSubmit } from "@/hooks/use-answer-submit";
import { humanBody } from "@/lib/api-client";
import type { Bead } from "@/lib/schema";
import type { HumanChoice, HumanQuestion, QuestionAnswer } from "@/lib/human-choices";

type Draft = { selected: HumanChoice[]; text: string; declined: boolean };

export function HumanQuestionnaire({ bead, initialQuestions, submit: override, disabled: held }: { bead: Bead; initialQuestions: HumanQuestion[]; submit?: AnswerSubmit; disabled?: boolean }) {
  const { readOnly } = useApp();
  const submit = useSubmitQuestions();
  const sink = useAnswerSubmit(override);
  const send = (action: "respond" | "dismiss", list: QuestionAnswer[]) => override
    ? sink.run(humanBody.submit(action, list))
    : submit.mutate({ id: bead.id, action, answers: list });
  // Keep the shown questions and chosen snapshots stable until a refresh. The server rejects stale submissions.
  const [questions] = React.useState(initialQuestions);
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>(() => Object.fromEntries(questions.map((q) => [q.id, { selected: [], text: "", declined: false }])));
  const disabled = readOnly || !!held || sink.pending || submit.isPending || (!override && bead.status === "closed");
  const update = (id: string, change: (draft: Draft) => Draft) => setDrafts((previous) => ({ ...previous, [id]: change(previous[id]) }));
  const answers = questions.map((q): QuestionAnswer | null => {
    const draft = drafts[q.id];
    const text = draft.text.trim();
    if (draft.declined && !text) return null;
    if (!text && draft.selected.length === 0) return null;
    return { id: q.id, question: q.question, header: q.header, multiSelect: q.multiSelect,
      action: draft.declined ? "declined" : "responded", choices: draft.declined || text ? null : draft.selected, text: text || null };
  });
  const complete = answers.every((answer) => answer !== null);
  const recommendations = questions.map((q): QuestionAnswer => ({ id: q.id, question: q.question, header: q.header,
    multiSelect: q.multiSelect, action: "responded", choices: [{ version: 1, ...q.options[0] }], text: null }));
  const error = sink.error ?? (submit.error instanceof Error ? submit.error.message : submit.error ? "The answers could not be saved." : null);

  return (
    <div data-human-answer={bead.id} className="min-w-0">
      <p className="mb-3 text-[12px] text-[var(--text-2)]">Answer or decline every question. Then submit once.</p>
      <div className="flex flex-col gap-4">
        {questions.map((question) => {
          const draft = drafts[question.id];
          return (
            <fieldset key={question.id} data-question-id={question.id} disabled={disabled} className="min-w-0 rounded-lg border border-border p-3">
              <legend className="px-1 text-[12px] font-[600]">{question.header}</legend>
              <p className="mb-2 text-[13px] font-[600]">{question.question}</p>
              <div role="group" aria-label={`Choices for ${question.header}`} className="mb-2 flex flex-col gap-2">
                {question.options.map((option) => {
                  const selected = !draft.declined && draft.selected.some((c) => c.id === option.id);
                  const choice: HumanChoice = { version: 1, ...option };
                  return (
                    <button key={option.id} type="button" disabled={disabled} aria-pressed={selected}
                      style={selected ? { borderColor: "var(--brand)", boxShadow: "0 0 0 1px var(--brand)" } : undefined}
                      onClick={() => update(question.id, (previous) => ({ ...previous, declined: false, selected: selected
                        ? previous.selected.filter((c) => c.id !== option.id) : question.multiSelect ? [...previous.selected, choice] : [choice] }))}
                      className="w-full rounded-lg border border-border bg-[var(--surface-2)] p-3 text-left whitespace-normal break-words focus-visible:outline-2 focus-visible:outline-[var(--brand)] disabled:opacity-50">
                      <span className="flex flex-wrap items-center gap-2 text-[13px] font-[600]">
                        {selected && <span aria-hidden="true">✓</span>}{option.label}
                        {option.recommended && <span className="rounded bg-[var(--brand)] px-2 py-0.5 text-[11px] text-white">Recommended</span>}
                      </span>
                      <span className="mt-1 block text-[12px] text-[var(--text-2)]">{option.description}</span>
                    </button>
                  );
                })}
              </div>
              <textarea aria-label={`Answer for ${question.header}`} disabled={disabled} maxLength={4000} rows={2}
                placeholder="Write your own answer, or a reason to decline this question."
                value={draft.text} onChange={(event) => update(question.id, (previous) => ({ ...previous, text: event.target.value }))}
                className="mb-2 w-full resize-y rounded-lg border border-border bg-[var(--surface-2)] p-2 text-[13px] outline-none focus:border-[var(--brand)]" />
              <button type="button" disabled={disabled || (!draft.text.trim() && !draft.declined)} aria-pressed={draft.declined}
                onClick={() => update(question.id, (previous) => ({ ...previous, declined: !previous.declined, selected: [] }))}
                className="h-8 rounded-lg border border-border px-3 text-[12px] disabled:opacity-50">Decline question</button>
              {draft.declined && <p className="mt-2 text-[12px] text-[var(--text-2)]">Question declined. Your text supplies the reason.</p>}
              {!draft.declined && draft.text.trim() && draft.selected.length > 0 && <p className="mt-2 text-[12px] text-[var(--text-3)]">Your written answer takes precedence. Clear it to send the selected options.</p>}
            </fieldset>
          );
        })}
      </div>
      {error && <p role="alert" className="mt-2 text-[12px] text-red-500">{error}</p>}
      <p className="my-2 text-[12px] text-[var(--text-3)]">Dismiss uses the recommended choice for every question.</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={disabled} onClick={() => send("dismiss", recommendations)}
          className="h-8 rounded-lg border border-border px-3 text-[12px] disabled:opacity-50">Dismiss</button>
        <button type="button" disabled={disabled || !complete} onClick={() => send("respond", answers as QuestionAnswer[])}
          className="h-8 rounded-lg bg-[var(--brand)] px-3 text-[12px] text-white disabled:opacity-50">Respond</button>
      </div>
    </div>
  );
}
