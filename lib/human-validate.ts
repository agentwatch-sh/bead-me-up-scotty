import { z } from "zod";
import type { Bead } from "./schema";
import { parseChoices, choiceSnapshot, renderChoice, isMultiSelect, selectionSnapshot, renderSelection, renderDecline, parseQuestions, normalizeAnswers, renderGroup, validNote, NOTE_MAX } from "./human-choices";
import { REVIEW_KEY } from "./review";

export const humanBodySchema = z.discriminatedUnion("action", [
  // `click_id`: the id of the click that sent it; a retry of the same click keeps it (age-6mk, lib/answer-click.ts).
  z.object({ action: z.literal("decline"), text: z.string().min(1).max(4000).refine((value) => value.trim().length > 0), click_id: z.string().max(64).optional() }),
  // `note`: what the person typed with a choice; `text` holds it too, in the canonical comment.
  z.object({ action: z.literal("respond"), text: z.string().min(1), choice: z.unknown().optional(), choices: z.unknown().optional(), answers: z.unknown().optional(), note: z.string().optional(), click_id: z.string().max(64).optional() }),
  z.object({ action: z.literal("dismiss"), text: z.string().optional(), choice: z.unknown().optional(), answers: z.unknown().optional(), note: z.string().optional(), click_id: z.string().max(64).optional() }),
]);
export type HumanBody = z.infer<typeof humanBodySchema>;

export type HumanValidation =
  | { ok: true; comment: string | null; reason: "Responded" | "Dismissed" | "Declined" }
  | { ok: false; status: number; error: string; code: string };

const fail = (status: number, error: string, code: string): HumanValidation => ({ ok: false, status, error, code });

/**
 * The human route's checks on one answer, with no writes. `closedOk` lets a
 * closed item pass (a Reverse answers an item that the manager closed); a
 * deferred item and one without the `human` label never pass. Without it, a
 * closed item whose manager answer waits for review points to To Review.
 */
export function validateHumanAnswer(item: Bead | null, body: HumanBody, opts: { closedOk: boolean }): HumanValidation {
  // The manager answered and closed it while the person had it open in Needs You.
  if (!opts.closedOk && item?.status === "closed" && item.metadata?.[REVIEW_KEY] === "pending") {
    return fail(409, "Your manager answered this; review it in To Review.", "manager_answered");
  }
  const answerable = (b: Bead | null): b is Bead =>
    !!b && (opts.closedOk || b.status !== "closed") && b.status !== "deferred" && b.labels.includes("human");
  const questions = parseQuestions(item?.metadata?.["scotty.choices"]);
  if (questions && (body.action === "decline" || body.answers === undefined)) {
    return fail(409, "Answer or decline every question, then submit once.", "incomplete_answers");
  }
  // The person's comment is never dropped: it rides with a choice (`note`), or a Dismiss
  // with no choice keeps it as its comment (`text`). A note with nothing to ride on is refused.
  if (body.action !== "decline") {
    const withChoice = body.choice !== undefined || (body.action === "respond" && body.choices !== undefined);
    const bareDismissText = body.action === "dismiss" && body.choice === undefined && body.text !== undefined;
    if ((body.note !== undefined && (!withChoice || !validNote(body.note))) || (bareDismissText && !validNote(body.text))) {
      return fail(400, `A comment with a choice or a Dismiss holds 1 to ${NOTE_MAX} characters.`, "invalid_note");
    }
    // A bare Dismiss writes no comment, so it may close any item; one with a comment needs an open question.
    if (bareDismissText && !answerable(item)) return fail(409, "This question is no longer waiting for an answer.", "stale_question");
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
    if (body.text !== renderSelection(selected, body.note)) {
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
    if (body.text !== renderChoice(choice, body.note)) {
      return fail(400, "The choice comment does not match the selection.", "invalid_choice_text");
    }
  }
  // A plain free-text Respond needs an open question too, like every other answer with a
  // comment: a comment after someone else's close is discussion, never the answer (age-6mk).
  if (body.action === "respond" && !answerable(item)) return fail(409, "This question is no longer waiting for an answer.", "stale_question");
  const comment = body.action === "respond" || body.choice !== undefined || body.text !== undefined ? body.text! : null;
  return { ok: true, comment, reason: body.action === "respond" ? "Responded" : "Dismissed" };
}
