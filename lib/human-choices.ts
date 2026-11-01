/** Vanilla bd metadata and immutable human-answer snapshots. No server dependencies. */
export type HumanOption = { id: string; label: string; description: string; recommended: boolean };
export type HumanChoice = HumanOption & { version: 1 };

const byteLength = (value: string) => new TextEncoder().encode(value).length;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= max && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);

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

export function renderChoice(choice: HumanChoice): string {
  const snapshot = { version: 1, id: choice.id, label: choice.label, description: choice.description, recommended: choice.recommended };
  return `Selected: ${choice.label}\n${choice.description}\n\n\`\`\`board-choice\n${JSON.stringify(snapshot)}\n\`\`\``;
}

export function parseChoice(value: string): HumanChoice | null {
  const match = /\n\n```board-choice\n([^\n]+)\n```$/.exec(value);
  if (!match) return null;
  try {
    const choice = choiceSnapshot(JSON.parse(match[1]));
    return choice && renderChoice(choice) === value ? choice : null;
  } catch { return null; }
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

export function renderSelection(choices: HumanChoice[]): string {
  const selected = choices.map((choice) => ({ version: 1, id: choice.id, label: choice.label, description: choice.description, recommended: choice.recommended }));
  return `Selected: ${choices.map((c) => c.label).join("; ")}\n${choices.map((c) => `${c.label}: ${c.description}`).join("\n")}\n\n\`\`\`board-choices\n${JSON.stringify({ version: 1, choices: selected })}\n\`\`\``;
}

export function parseSelection(value: string): HumanChoice[] | null {
  const match = /\n\n```board-choices\n([^\n]+)\n```$/.exec(value);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    if (!record(data) || data.version !== 1 || Object.keys(data).sort().join(",") !== "choices,version") return null;
    const selected = selectionSnapshot(data.choices);
    return selected && renderSelection(selected) === value ? selected : null;
  } catch { return null; }
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
