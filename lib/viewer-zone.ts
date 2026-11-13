// The zone every time on the board is shown in, with the zone named
// (agentwatch board age-65t): "Nov 12, 2026, 15:30 ART". A relative time
// ("3d ago") stays as it is; text that someone typed stays as typed.
//
// A host (agentwatch) names one URL (SCOTTY_VIEWER_ZONE_URL, meta.viewerZoneUrl)
// that answers the viewer's zone and its letters: `{zone, labels:
// [{utc_offset_seconds, letters}]}`, the zone null when the host knows none.
// A time takes the letters of the zone's offset at that time ("EST" in
// January, "EDT" in July). With no URL, no answer or a null zone, the board
// uses the browser's own zone (Intl) and its short name ("GMT-3" written
// "UTC-3"). The page reads the zone at load and again at most every 15 minutes
// (the zone follows a trip), and a change renders again.
//
// No React and no imports: tested under node (scripts/test-viewer-zone.mjs).

/** How often the page reads the zone again (ms): at most every 15 minutes. */
export const ZONE_REFRESH_MS = 15 * 60 * 1000;

export interface ZoneLabel {
  offset: number;
  letters: string;
}
export interface ViewerZone {
  /** The host's zone, or null: the browser's own zone. */
  zone: string | null;
  labels: readonly ZoneLabel[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LETTERS_RE = /^(?:[A-Za-z]{1,6}|UTC[+-]\d{1,2}(?::\d{2})?)$/;

/** No zone from the host: the browser's own zone. */
export const NO_ZONE: ViewerZone = Object.freeze({ zone: null, labels: Object.freeze([]) as readonly ZoneLabel[] });

let current: ViewerZone = NO_ZONE;
const listeners = new Set<() => void>();

function knownZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The host's answer as a ViewerZone; a zone this browser does not know, or no answer, is NO_ZONE. */
export function normalizeZone(answer: unknown): ViewerZone {
  const data = answer && typeof answer === "object" ? (answer as Record<string, unknown>) : {};
  if (!knownZone(data.zone)) return NO_ZONE;
  const labels = (Array.isArray(data.labels) ? data.labels : [])
    .filter((l): l is { utc_offset_seconds: number; letters: string } =>
      !!l && typeof l === "object" && Number.isInteger((l as { utc_offset_seconds?: unknown }).utc_offset_seconds)
      && typeof (l as { letters?: unknown }).letters === "string"
      && LETTERS_RE.test((l as { letters: string }).letters))
    .map((l) => Object.freeze({ offset: l.utc_offset_seconds, letters: l.letters }));
  return Object.freeze({ zone: data.zone, labels: Object.freeze(labels) });
}

function sameZone(a: ViewerZone, b: ViewerZone): boolean {
  return a.zone === b.zone && a.labels.length === b.labels.length
    && a.labels.every((l, i) => l.offset === b.labels[i].offset && l.letters === b.labels[i].letters);
}

/** The zone the board shows times in now. */
export function viewerZone(): ViewerZone {
  return current;
}

/** Take a host answer; true (and every listener called) when the zone changed. */
export function setViewerZone(answer: unknown): boolean {
  const next = normalizeZone(answer);
  if (sameZone(next, current)) return false;
  current = next;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      // One listener's failure never stops the others.
    }
  }
  return true;
}

/** Call *fn* after each change of the zone; returns the unsubscribe (useSyncExternalStore's shape). */
export function subscribeViewerZone(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The browser's own zone, else UTC. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The zone a time is shown in: the host's, else the browser's. */
export function shownZone(info: ViewerZone = current): string {
  return info && knownZone(info.zone) ? info.zone : browserZone();
}

const ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i;

/**
 * A moment from data: a Date, epoch seconds or milliseconds (a number under
 * 1e11 is seconds), or a string (ISO 8601; a date and time with no zone is
 * UTC). null when it is not a valid moment, or 0 or less.
 */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    const date = new Date(value < 1e11 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (/^\d+(?:\.\d+)?$/.test(text)) return toDate(Number(text));
  const iso = ISO_RE.exec(text);
  if (iso) {
    let zone = (iso[3] || "Z").toUpperCase();
    if (zone === "UTC") zone = "Z";
    else if (zone !== "Z" && !zone.includes(":")) zone = `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const date = new Date(`${iso[1]}T${iso[2]}${zone}`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallClock(date: Date, zone: string): WallClock {
  let fmt = formatters.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", weekday: "short", year: "numeric",
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(zone, fmt);
  }
  const out: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) out[part.type] = part.value;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour) % 24, minute: Number(out.minute), second: Number(out.second),
    weekday: out.weekday,
  };
}

/** Seconds east of UTC that *zone* is at *date*. */
export function zoneOffsetSeconds(date: Date, zone: string): number {
  const w = wallClock(date, zone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 1000);
}

/** "UTC-3", "UTC+5:45": a zone with no letters, as agentwatch writes it. */
export function offsetLabel(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const total = Math.floor(Math.abs(seconds) / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes ? `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}` : `UTC${sign}${hours}`;
}

function intlLetters(date: Date, zone: string): string {
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(date).find((p) => p.type === "timeZoneName")?.value || "";
    if (/^[A-Za-z]{1,6}$/.test(name)) return name;
    const gmt = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
    if (gmt) return `UTC${gmt[1]}${Number(gmt[2])}${gmt[3] && gmt[3] !== "00" ? `:${gmt[3]}` : ""}`;
  } catch {
    // No short name: the offset.
  }
  return offsetLabel(zoneOffsetSeconds(date, zone));
}

/** How a time at *value* is named: the host's letters of the offset then, else the browser's short name. */
export function zoneLetters(value: unknown, info: ViewerZone = current): string {
  const date = toDate(value);
  if (!date) return "";
  const zone = shownZone(info);
  if (info && info.zone === zone) {
    const offset = zoneOffsetSeconds(date, zone);
    const hit = info.labels.find((l) => l.offset === offset);
    if (hit) return hit.letters;
  }
  return intlLetters(date, zone);
}

export interface ZonedParts extends WallClock {
  monthName: string;
  letters: string;
  zone: string;
}

/** The wall clock of *value* in the shown zone, or null for no valid time. */
export function zonedParts(value: unknown, info: ViewerZone = current): ZonedParts | null {
  const date = toDate(value);
  if (!date) return null;
  const zone = shownZone(info);
  const w = wallClock(date, zone);
  return { ...w, monthName: MONTHS[w.month - 1], letters: zoneLetters(date, info), zone };
}

const two = (n: number) => String(n).padStart(2, "0");

/** "15:30 ART"; '' for no valid time. */
export function formatClock(value: unknown, info: ViewerZone = current): string {
  const p = zonedParts(value, info);
  return p ? `${two(p.hour)}:${two(p.minute)} ${p.letters}` : "";
}

/** "Nov 12, 2026, 15:30 ART" ("Nov 12, 15:30 ART" with year false); '' for no valid time. */
export function formatDateTime(value: unknown, info: ViewerZone = current, { year = true }: { year?: boolean } = {}): string {
  const p = zonedParts(value, info);
  if (!p) return "";
  return `${p.monthName} ${p.day}${year ? `, ${p.year}` : ""}, ${two(p.hour)}:${two(p.minute)} ${p.letters}`;
}

/** "2026-11-12": the calendar day in the shown zone. */
export function dayKey(value: unknown, info: ViewerZone = current): string {
  const p = zonedParts(value, info);
  return p ? `${p.year}-${two(p.month)}-${two(p.day)}` : "";
}

/** Read the zone once from *url* (same origin; the browser sends its own login); a failed read keeps the zone. */
export async function loadViewerZone(
  url: string,
  fetcher: (u: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }> = (u) =>
    fetch(u, { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" }),
): Promise<boolean> {
  try {
    const res = await fetcher(url);
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: unknown } | null;
    const data = body && typeof body === "object" && "data" in body ? body.data : body;
    if (data && typeof data === "object") setViewerZone(data);
    return true;
  } catch {
    return false;
  }
}

/** Only a path on this origin is a zone URL (the browser sends its own login). */
export function sameOriginPath(url: unknown): string | null {
  return typeof url === "string" && url.startsWith("/") && !url.startsWith("//") && !url.includes("\\")
    ? url : null;
}
