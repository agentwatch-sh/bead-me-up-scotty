"use client";
import * as React from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import type { ColumnDef } from "./column";

/**
 * Drop targets for the board columns that are hidden because they have no cards.
 * While a card is dragged, the bar covers the column-header row (the names and
 * counts at the top of the board area) and ends above the first card, so it
 * never covers a column body: a card can never sit under it, and every column
 * keeps all of its own drop area. Nothing moves or resizes when it appears. A
 * drop on a target counts as a drop on that column: the board maps the target's
 * id back to the column.
 */
const PREFIX = "drop-bar:";

export function dropBarId(columnId: string): string {
  return `${PREFIX}${columnId}`;
}

/** The column a drop-bar target stands for, or undefined for any other id. */
export function columnOfDropBarId(id: string): string | undefined {
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : undefined;
}

export function DropBar({
  columns,
  height,
  dropTargetId,
}: {
  columns: ColumnDef[];
  /** The bar's height in px: from the top of the board area to just above the column bodies. */
  height: number;
  dropTargetId?: string;
}) {
  return (
    <div
      data-drop-bar
      role="group"
      aria-label="Move to a hidden column"
      style={{ height }}
      className="absolute inset-x-0 top-0 z-10 flex items-stretch gap-3 border-b border-border bg-[var(--surface)]/95 px-[22px] py-px shadow-[var(--shadow)] backdrop-blur-sm"
    >
      {columns.map((col) => (
        <DropBarTarget key={col.id} col={col} active={dropTargetId === col.id} />
      ))}
    </div>
  );
}

function DropBarTarget({ col, active }: { col: ColumnDef; active: boolean }) {
  const { setNodeRef } = useDroppable({ id: dropBarId(col.id) });
  return (
    <div
      ref={setNodeRef}
      data-drop-bar-target={col.id}
      className={cn(
        "flex w-[296px] min-w-0 flex-shrink items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed px-3 text-[13px] font-semibold transition-[background,border-color]",
        active
          ? "border-[var(--brand)] bg-[var(--brand-weak)] text-[var(--brand)]"
          : "border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-2)]",
      )}
    >
      <span className="h-[9px] w-[9px] flex-shrink-0 rounded-[3px]" style={{ background: col.color }} />
      <span className="truncate">Move to {col.name}</span>
    </div>
  );
}
