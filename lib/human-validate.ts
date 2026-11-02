import { z } from "zod";
import type { Bead } from "./schema";
import { parseChoices, choiceSnapshot, renderChoice, isMultiSelect, selectionSnapshot, renderSelection, renderDecline, parseQuestions, normalizeAnswers, renderGroup } from "./human-choices";

export const humanBodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("decline"), text: z.string().min(1).max(4000).refine((value) => value.trim().length > 0) }),
  z.object({ action: z.literal("respond"), text: z.string().min(1), choice: z.unknown().optional(), choices: z.unknown().optional(), answers: z.unknown().optional() }),
  z.object({ action: z.literal("dismiss"), text: z.string().optional(), choice: z.unknown().optional(), answers: z.unknown().optional() }),
]);
export type HumanBody = z.infer<typeof humanBodySchema>;

export type HumanValidation =
  | { ok: true; comment: string | null; reason: "Responded" | "Dismissed" | "Declined" }
  | { ok: false; status: number; error: string; code: string };

const fail = (status: number, error: string, code: string): HumanValidation => ({ ok: false, status, error, code });

/**
 * The human route's checks on one answer, with no writes. `closedOk` lets a
 * closed item pass (a Reverse answers an item that the manager closed); a
 * deferred item and one without the `human` label never pass.
 */
export function validateHumanAnswer(item: Bead | null, body: HumanBody, opts: { closedOk: boolean }): HumanValidation {
  const answerable = (b: Bead | null): b is Bead =>
    !!b && (opts.closedOk || b.status !== "closed") && b.status !== "deferred" && b.labels.includes("human");
  const questions = parseQuestions(item?.metadata?.["scotty.choices"]);
  if (questions && (body.action === "decline" || body.answers === undefined)) {
    return fail(409, "Answer or decline every question, then submit once.", "incomplete_answers");
  }
  if (body.action !== "decline" && body.answers !== undefined) {
    const answers = normalizeAnswers(body.answers);
    if (!answerable(item)
      || body.choice !== undefined || (body.action === "respond" && body.choices !== undefined)
      || !questions || !answers || questions.length !== answers.length
      || answers.some((answer, i) => {
        const question = questions[i];
        return answer.id !== question.id || answer.question !== question.question || answer.header !== question.header
          || answer.multiSelect !== question.multiSelect || answer.choices?.some((choice) => {
            const option = question.options.find((o) => o.id === choice.id);
            return !option || renderChoice({ version: 1, ...option }) !== renderChoice(choice);
          }) || (body.action === "dismiss" && (answer.action !== "responded" || answer.choices?.length !== 1 || !answer.choices[0].recommended));
      })) return fail(409, "The questions changed or the answers are incomplete. Refresh and answer every question.", "stale_questions");
    if (body.text !== renderGroup(answers!)) return fail(400, "The comment does not match the answers.", "invalid_answers_text");
    return { ok: true, comment: body.text, reason: body.action === "dismiss" ? "Dismissed" : "Responded" };
  }
  if (body.action === "decline") {
    if (!answerable(item)) return fail(409, "This question is no longer waiting for an answer.", "stale_question");
    return { ok: true, comment: renderDecline(body.text), reason: "Declined" };
  }
  if (body.action === "respond" && body.choices !== undefined) {
    const selected = selectionSnapshot(body.choices);
    const options = parseChoices(item?.metadata?.["scotty.choices"]);
    if (body.choice !== undefined || !answerable(item) || !isMultiSelect(item.metadata?.["scotty.choices"])
      || !selected || !options || selected.some((choice) => {
        const current = options.find((o) => o.id === choice.id);
        return !current || renderChoice({ version: 1, ...current }) !== renderChoice(choice);
      })) return fail(409, "The choices changed. Refresh the question and select again.", "stale_choice");
    if (body.text !== renderSelection(selected)) {
      return fail(400, "The choice comment does not match the selection.", "invalid_choice_text");
    }
  }
  if (body.choice !== undefined) {
    const choice = choiceSnapshot(body.choice);
    const options = parseChoices(item?.metadata?.["scotty.choices"]);
    const current = options?.find((o) => o.id === choice?.id);
    if (!answerable(item) || !choice || !current || renderChoice({ version: 1, ...current }) !== renderChoice(choice)
      || (body.action === "dismiss" && !choice.recommended)) {
      return fail(409, "The choices changed. Refresh the question and select again.", "stale_choice");
    }
    if (body.text !== renderChoice(choice)) {
      return fail(400, "The choice comment does not match the selection.", "invalid_choice_text");
    }
  }
  const comment = body.action === "respond" || body.choice !== undefined ? body.text! : null;
  return { ok: true, comment, reason: body.action === "respond" ? "Responded" : "Dismissed" };
}
