import { getStore } from "@/lib/store";
import { getConfig } from "@/lib/config";
import { ok, fail } from "@/lib/api";
import { parseChoices, choiceSnapshot, renderChoice, isMultiSelect, selectionSnapshot, renderSelection, renderDecline, parseQuestions, normalizeAnswers, renderGroup } from "@/lib/human-choices";
import { z } from "zod";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ projectId: string; id: string }> };

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("decline"), text: z.string().min(1).max(4000).refine((value) => value.trim().length > 0) }),
  z.object({ action: z.literal("respond"), text: z.string().min(1), choice: z.unknown().optional(), choices: z.unknown().optional(), answers: z.unknown().optional() }),
  z.object({ action: z.literal("dismiss"), text: z.string().optional(), choice: z.unknown().optional(), answers: z.unknown().optional() }),
]);

/**
 * Act on a "Needs You" (human-labelled) bead. Matches `bd human` (upstream
 * issue #88; fork-only until that lands):
 *  - respond → post a comment answering the agent's question, then close the
 *    bead with reason "Responded". The `human` label stays as the record.
 *  - dismiss → close the bead with reason "Dismissed"; the label stays.
 * Closing a question that blocks a work bead unblocks that work bead.
 *
 * SCOTTY_HUMAN_RESPOND=keep-open restores the old behaviour: respond comments
 * and clears the `human` label; dismiss clears the label. Status is unchanged.
 */
export async function POST(req: Request, { params }: Ctx) {
  try {
    const { projectId, id } = await params;
    const store = await getStore(projectId);
    const cfg = getConfig();
    const body = bodySchema.parse(await req.json());
    const keepOpen = process.env.SCOTTY_HUMAN_RESPOND === "keep-open";

    const item = await store.get(id);
    const questions = parseQuestions(item?.metadata?.["scotty.choices"]);
    if (questions && (body.action === "decline" || body.answers === undefined)) {
      return ok({ error: "Answer or decline every question, then submit once.", code: "incomplete_answers" }, 409);
    }
    if (body.action !== "decline" && body.answers !== undefined) {
      const answers = normalizeAnswers(body.answers);
      if (!item || item.status === "closed" || item.status === "deferred" || !item.labels.includes("human")
        || body.choice !== undefined || (body.action === "respond" && body.choices !== undefined)
        || !questions || !answers || questions.length !== answers.length
        || answers.some((answer, i) => {
          const question = questions[i];
          return answer.id !== question.id || answer.question !== question.question || answer.header !== question.header
            || answer.multiSelect !== question.multiSelect || answer.choices?.some((choice) => {
              const option = question.options.find((o) => o.id === choice.id);
              return !option || renderChoice({ version: 1, ...option }) !== renderChoice(choice);
            }) || (body.action === "dismiss" && (answer.action !== "responded" || answer.choices?.length !== 1 || !answer.choices[0].recommended));
        })) return ok({ error: "The questions changed or the answers are incomplete. Refresh and answer every question.", code: "stale_questions" }, 409);
      if (body.text !== renderGroup(answers)) return ok({ error: "The comment does not match the answers.", code: "invalid_answers_text" }, 400);
      await store.addComment(id, body.text, cfg.humanActor);
      if (keepOpen) return ok(await store.removeLabel(id, "human", cfg.humanActor));
      return ok(await store.setStatus(id, "closed", cfg.humanActor, body.action === "dismiss" ? "Dismissed" : "Responded"));
    }
    if (body.action === "decline") {
      const bead = await store.get(id);
      if (!bead || bead.status === "closed" || bead.status === "deferred" || !bead.labels.includes("human")) {
        return ok({ error: "This question is no longer waiting for an answer.", code: "stale_question" }, 409);
      }
      await store.addComment(id, renderDecline(body.text), cfg.humanActor);
      return ok(await store.setStatus(id, "closed", cfg.humanActor, "Declined"));
    }
    if (body.action === "respond" && body.choices !== undefined) {
      const bead = await store.get(id);
      const selected = selectionSnapshot(body.choices);
      const options = parseChoices(bead?.metadata?.["scotty.choices"]);
      if (body.choice !== undefined || !bead || bead.status === "closed" || bead.status === "deferred"
        || !bead.labels.includes("human") || !isMultiSelect(bead.metadata?.["scotty.choices"])
        || !selected || !options || selected.some((choice) => {
          const current = options.find((o) => o.id === choice.id);
          return !current || renderChoice({ version: 1, ...current }) !== renderChoice(choice);
        })) return ok({ error: "The choices changed. Refresh the question and select again.", code: "stale_choice" }, 409);
      if (body.text !== renderSelection(selected)) {
        return ok({ error: "The choice comment does not match the selection.", code: "invalid_choice_text" }, 400);
      }
    }
    if (body.choice !== undefined) {
      const bead = await store.get(id);
      const choice = choiceSnapshot(body.choice);
      const options = parseChoices(bead?.metadata?.["scotty.choices"]);
      const current = options?.find((o) => o.id === choice?.id);
      if (!bead || bead.status === "closed" || bead.status === "deferred" || !bead.labels.includes("human")
        || !choice || !current || renderChoice({ version: 1, ...current }) !== renderChoice(choice)
        || (body.action === "dismiss" && !choice.recommended)) {
        return ok({ error: "The choices changed. Refresh the question and select again.", code: "stale_choice" }, 409);
      }
      if (body.text !== renderChoice(choice)) {
        return ok({ error: "The choice comment does not match the selection.", code: "invalid_choice_text" }, 400);
      }
    }
    if (body.action === "respond" || body.choice !== undefined) await store.addComment(id, body.text!, cfg.humanActor);
    if (keepOpen) return ok(await store.removeLabel(id, "human", cfg.humanActor));
    const reason = body.action === "respond" ? "Responded" : "Dismissed";
    return ok(await store.setStatus(id, "closed", cfg.humanActor, reason));
  } catch (e) {
    return fail(e);
  }
}
