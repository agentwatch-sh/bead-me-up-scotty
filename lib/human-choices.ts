/** Vanilla bd metadata and immutable human-answer snapshots. No server dependencies. */
export type HumanOption = { id: string; label: string; description: string; recommended: boolean };
export type HumanChoice = HumanOption & { version: 1 };

const byteLength = (value: string) => new TextEncoder().encode(value).length;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= max && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

/** The most characters of the operator's note: what they typed with a choice or a Dismiss. */
export const NOTE_MAX = 4000;
const NOTE_PREFIX = "The person also wrote: ";
export const validNote = (value: unknown): value is string => text(value, NOTE_MAX);

/** The visible note paragraph before the fence, or nothing. Only undefined means no note. */
function noteLine(note: string | undefined): string {
  if (note === undefined) return "";
  if (!validNote(note)) throw new Error("Invalid note");
  return `\n\n${NOTE_PREFIX}${note}`;
}

/** The fenced object without its `note`, and the note; a bad note throws. */
function splitNote(data: unknown): [unknown, string | undefined] {
  if (!record(data) || !("note" in data)) return [data, undefined];
  const { note, ...rest } = data;
  if (!validNote(note)) throw new Error("Invalid note");
  return [rest, note];
}

function option(value: unknown): value is HumanOption {
  return record(value) && typeof value.id === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(value.id)
    && text(value.label, 80) && text(value.description, 240) && typeof value.recommended === "boolean";
}

export function parseChoices(value: unknown): HumanOption[] | null {
  try {
    if (typeof value === "string") {
      if (byteLength(value) > 8192) return null;
      value = JSON.parse(value);
    }
    if (!record(value) || byteLength(JSON.stringify(value)) > 8192 || value.version !== 1 || (value.multiSelect !== undefined && typeof value.multiSelect !== "boolean") || !Array.isArray(value.options)) return null;
    const options = value.options;
    if (options.length < 2 || options.length > 4 || !options.every(option)
      || new Set(options.map((o) => o.id)).size !== options.length
      || options.filter((o) => o.recommended).length !== 1) return null;
    return [...options.filter((o) => o.recommended), ...options.filter((o) => !o.recommended)]
      .map(({ id, label, description, recommended }) => ({ id, label, description, recommended }));
  } catch { return null; }
}

export function choiceSnapshot(value: unknown): HumanChoice | null {
  if (!option(value) || !record(value) || (value as Record<string, unknown>).version !== 1
    || Object.keys(value).sort().join(",") !== "description,id,label,recommended,version") return null;
  return { version: 1, id: value.id, label: value.label, description: value.description, recommended: value.recommended };
}

/** One canonical comment; `note` (what the person typed with the choice) is its own paragraph and the fence's last key. */
export function renderChoice(choice: HumanChoice, note?: string): string {
  const snapshot = { version: 1, id: choice.id, label: choice.label, description: choice.description, recommended: choice.recommended };
  const line = noteLine(note);
  return `Selected: ${choice.label}\n${choice.description}${line}\n\n\`\`\`board-choice\n${JSON.stringify(note === undefined ? snapshot : { ...snapshot, note })}\n\`\`\``;
}

function parseChoiceAndNote(value: string): [HumanChoice, string | undefined] | null {
  const match = /\n\n```board-choice\n([^\n]+)\n```$/.exec(value);
  if (!match) return null;
  try {
    const [data, note] = splitNote(JSON.parse(match[1]));
    const choice = choiceSnapshot(data);
    return choice && renderChoice(choice, note) === value ? [choice, note] : null;
  } catch { return null; }
}

export function parseChoice(value: string): HumanChoice | null {
  return parseChoiceAndNote(value)?.[0] ?? null;
}


export function isMultiSelect(value: unknown): boolean {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return false; }
  }
  return record(value) && value.multiSelect === true && parseChoices(value) !== null;
}

export function selectionSnapshot(value: unknown): HumanChoice[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const selected = value.map(choiceSnapshot);
  if (selected.some((c) => c === null)) return null;
  const choices = selected as HumanChoice[];
  if (new Set(choices.map((c) => c.id)).size !== choices.length || choices.filter((c) => c.recommended).length > 1) return null;
  return choices;
}

export function renderSelection(choices: HumanChoice[], note?: string): string {
  const selected = choices.map((choice) => ({ version: 1, id: choice.id, label: choice.label, description: choice.description, recommended: choice.recommended }));
  const line = noteLine(note);
  const fenced = note === undefined ? { version: 1, choices: selected } : { version: 1, choices: selected, note };
  return `Selected: ${choices.map((c) => c.label).join("; ")}\n${choices.map((c) => `${c.label}: ${c.description}`).join("\n")}${line}\n\n\`\`\`board-choices\n${JSON.stringify(fenced)}\n\`\`\``;
}

function parseSelectionAndNote(value: string): [HumanChoice[], string | undefined] | null {
  const match = /\n\n```board-choices\n([^\n]+)\n```$/.exec(value);
  if (!match) return null;
  try {
    const [data, note] = splitNote(JSON.parse(match[1]));
    if (!record(data) || data.version !== 1 || Object.keys(data).sort().join(",") !== "choices,version") return null;
    const selected = selectionSnapshot(data.choices);
    return selected && renderSelection(selected, note) === value ? [selected, note] : null;
  } catch { return null; }
}

export function parseSelection(value: string): HumanChoice[] | null {
  return parseSelectionAndNote(value)?.[0] ?? null;
}

/** The person's note in a canonical choice or selection comment, else null. */
export function parseNote(value: string): string | null {
  return (parseChoiceAndNote(value) ?? parseSelectionAndNote(value))?.[1] ?? null;
}

export function renderDecline(reason: string): string {
  return `The person declined this question: ${reason}\n\n\`\`\`board-decline\n${JSON.stringify({ version: 1, text: reason })}\n\`\`\``;
}

export function parseDecline(value: string): string | null {
  const match = /\n\n```board-decline\n([^\n]+)\n```$/.exec(value);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    if (!record(data) || data.version !== 1 || Object.keys(data).sort().join(",") !== "text,version" || !text(data.text, 4000)) return null;
    return renderDecline(data.text) === value ? data.text : null;
  } catch { return null; }
}

export type HumanQuestion = { id: string; question: string; header: string; multiSelect: boolean; options: HumanOption[] };
/** `note` is what the person typed with the question's choice; only a choice has one. */
export type QuestionAnswer = Omit<HumanQuestion, "options"> & { action: "responded" | "declined"; choices: HumanChoice[] | null; text: string | null; note?: string };

function questionIdentity(value: unknown): value is Omit<HumanQuestion, "options"> & Record<string, unknown> {
  return record(value) && typeof value.id === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(value.id)
    && text(value.question, 500) && text(value.header, 12) && typeof value.multiSelect === "boolean";
}

export function parseQuestions(value: unknown): HumanQuestion[] | null {
  try {
    if (typeof value === "string") {
      if (byteLength(value) > 32768) return null;
      value = JSON.parse(value);
    }
    if (!record(value) || value.version !== 2 || byteLength(JSON.stringify(value)) > 32768
      || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 4) return null;
    const questions: HumanQuestion[] = [];
    for (const entry of value.questions) {
      if (!record(entry)) return null;
      const q = { multiSelect: false, ...entry };
      if (!questionIdentity(q)) return null;
      const options = parseChoices({ version: 1, options: q.options, multiSelect: q.multiSelect });
      if (!options) return null;
      questions.push({ id: q.id, question: q.question, header: q.header, multiSelect: q.multiSelect, options });
    }
    return new Set(questions.map((q) => q.id)).size === questions.length ? questions : null;
  } catch { return null; }
}

export function normalizeAnswers(value: unknown): QuestionAnswer[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) return null;
  const answers: QuestionAnswer[] = [];
  for (const entry of value) {
    // A note is an optional last key.
    if (!questionIdentity(entry) || Object.keys(entry).filter((k) => k !== "note").sort().join(",") !== "action,choices,header,id,multiSelect,question,text") return null;
    const choices = entry.choices !== null ? selectionSnapshot(entry.choices) : null;
    if (entry.action === "responded") {
      if (choices) {
        if (entry.text !== null || (!entry.multiSelect && choices.length !== 1)) return null;
      } else if (entry.choices !== null || !text(entry.text, 4000)) return null;
    } else if (entry.action !== "declined" || entry.choices !== null || !text(entry.text, 4000)) return null;
    if ("note" in entry && (!choices || !validNote(entry.note))) return null;
    answers.push({ id: entry.id, question: entry.question, header: entry.header, multiSelect: entry.multiSelect,
      action: entry.action, choices, text: entry.text as string | null, ...("note" in entry ? { note: entry.note as string } : {}) });
  }
  return new Set(answers.map((a) => a.id)).size === answers.length ? answers : null;
}

export function renderGroup(answers: QuestionAnswer[]): string {
  const normalized = answers.map((a) => ({ id: a.id, question: a.question, header: a.header, multiSelect: a.multiSelect,
    action: a.action, choices: a.choices, text: a.text, ...(a.note !== undefined ? { note: a.note } : {}) }));
  const sections = answers.map((answer) => {
    const result = answer.action === "declined" ? `The person declined this question: ${answer.text}`
      : answer.choices ? `Selected: ${answer.choices.map((c) => c.label).join("; ")}${answer.note !== undefined ? `\n${NOTE_PREFIX}${answer.note}` : ""}`
      : `The person answered: ${answer.text}`;
    return `${answer.header}: ${answer.question}\n${result}`;
  });
  return `${sections.join("\n\n")}\n\n\`\`\`board-answers\n${JSON.stringify({ version: 2, answers: normalized })}\n\`\`\``;
}

export function parseGroup(value: string): QuestionAnswer[] | null {
  const match = /\n\n```board-answers\n([^\n]+)\n```$/.exec(value);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    if (!record(data) || data.version !== 2 || Object.keys(data).sort().join(",") !== "answers,version") return null;
    const answers = normalizeAnswers(data.answers);
    return answers && renderGroup(answers) === value ? answers : null;
  } catch { return null; }
}
