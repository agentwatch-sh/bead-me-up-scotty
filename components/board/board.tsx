"use client";
import * as React from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  pointerWithin,
  DragOverlay,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { toast } from "sonner";
import { Icon } from "@/components/icons";
import { useApp } from "@/components/app-context";
import { useSetStatus } from "@/hooks/use-beads";
import { useOrder, useSetOrder } from "@/hooks/use-order";
import { useBoardPrefs } from "@/hooks/use-board-prefs";
import { useUrlFilters } from "@/hooks/use-url-filters";
import { useUrlState } from "@/hooks/use-url-state";
import { blockKind, childrenCountMap } from "@/lib/beads-view";
import { FilterBar } from "@/components/filter-bar";
import { matchesFilters, labelOptionsFrom, assigneeOptionsFrom } from "@/lib/filters";
import {
  BOARD_COLUMNS as COLUMNS,
  colOf,
  sortBoardCards,
  type BoardSortMode,
} from "@/lib/board-columns";
import { BeadCardOverlay } from "./bead-card";
import { Column } from "./column";
import { DropBar, columnOfDropBarId } from "./drop-bar";
import type { Bead } from "@/lib/schema";

// Whatever is under the pointer wins. pointerWithin sorts its hits by the average distance
// from the pointer to each rect's corners, so a card beats the much taller column that
// contains it, and empty space low in a short column stays a valid target. closestCorners
// alone can prefer a card in a long neighboring column whose corners sit nearer the
// dragged card's. It remains the fallback when the pointer is between columns.
//
// The drop bar covers only the column-header row, never a column body. Its targets
// count only when the pointer is under one AND at least BAR_ARM_DISTANCE px from
// where the drag started, so a short wiggle that starts a drag can never end on the
// bar. The between-columns fallback never picks the bar.
const BAR_ARM_DISTANCE = 24;
function pointerFirstCollision(
  args: Parameters<CollisionDetection>[0],
  start: { x: number; y: number } | null,
): ReturnType<CollisionDetection> {
  const p = args.pointerCoordinates;
  const barArmed = !!start && !!p && Math.hypot(p.x - start.x, p.y - start.y) >= BAR_ARM_DISTANCE;
  const isBar = (id: unknown) => columnOfDropBarId(String(id)) !== undefined;
  const underPointer = pointerWithin(args);
  const onBar = underPointer.filter((hit) => isBar(hit.id));
  if (onBar.length > 0) return barArmed ? onBar : [];
  if (underPointer.length > 0) return underPointer;
  return closestCorners({ ...args, droppableContainers: args.droppableContainers.filter((c) => !isBar(c.id)) });
}

/** The pointer position of the event that started a drag, if it has one. */
function pointOf(event: Event | null): { x: number; y: number } | null {
  if (event && "clientX" in event && "clientY" in event) {
    return { x: Number(event.clientX), y: Number(event.clientY) };
  }
  return null;
}

/** Space left between the drop bar and the top of the column bodies. */
const BAR_GAP = 2;
/**
 * A drag whose pointer ends this close to where it started changes nothing. A tap
 * that wiggles past the 5 px activation distance (common with a finger) starts a
 * drag; near a card's edge, or while a held card scrolls its column, its release
 * could otherwise reorder the card or move it to whatever is under the pointer.
 * No real move is this short. The distance is the pointer's own movement, not the
 * scroll-adjusted one.
 */
const IN_PLACE_DISTANCE = 12;

const BOARD_SCROLL = "bd-scroll min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-[18px_22px]";

export function Board() {
  const { beads, index, humanAllowlist, openCreate, loading, projectId, readOnly } = useApp();
  const setStatus = useSetStatus();
  const { data: orderData } = useOrder(projectId);
  const setOrder = useSetOrder(projectId);
  const { prefs: boardPrefs, setPrefs: setBoardPrefs } = useBoardPrefs();
  const orders = React.useMemo(() => orderData?.orders ?? {}, [orderData]);
  const { filters, setFilters, showArchived, setShowArchived, clearFilters } =
    useUrlFilters();
  const { searchParams, updateUrl } = useUrlState();
  // Derived from ALL beads (not the filtered set) so selecting one label
  // doesn't make the remaining options vanish from the dropdown.
  const labelOptions = React.useMemo(() => labelOptionsFrom(beads), [beads]);
  const assigneeOptions = React.useMemo(() => assigneeOptionsFrom(beads), [beads]);
  // One pass over all beads, not childrenOf() per card — that would be O(n^2)
  // on a large board.
  const childCounts = React.useMemo(() => childrenCountMap(beads), [beads]);
  // Time-window filter for the Done column: null = all, else "closed within N days".
  const doneParam = Number(searchParams.get("done"));
  const doneWindow = [7, 28, 90, 365].includes(doneParam) ? doneParam : null;
  const setDoneWindow = React.useCallback(
    (days: number | null) => {
      updateUrl((params) => {
        if (days === null) params.delete("done");
        else params.set("done", String(days));
      });
    },
    [updateUrl],
  );
  // Mount-time "now" for the window cutoff — captured once (day-granular, so it
  // needn't tick) and kept out of render to satisfy the no-impure-call rule.
  const [now] = React.useState(() => Date.now());

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // The card being dragged and the column under the pointer. The card renders in a
  // DragOverlay so it can travel across columns; in place it is confined to (and
  // clipped by) its own column's list.
  const [draggingId, setDraggingId] = React.useState<string | null>(null);
  const [overColumnId, setOverColumnId] = React.useState<string | null>(null);
  // The columns on screen when the drag started. A live update during the drag
  // can empty or fill a column; the row keeps this set until the drag ends, so no
  // column appears or goes under the pointer.
  const [frozenShown, setFrozenShown] = React.useState<string[] | null>(null);
  // The drop bar's height, measured when the drag starts (see onDragStart).
  const [barHeight, setBarHeight] = React.useState(0);
  const boardAreaRef = React.useRef<HTMLDivElement>(null);
  const dragStart = React.useRef<{ x: number; y: number } | null>(null);
  const lastPointer = React.useRef<{ x: number; y: number } | null>(null);
  const collisionDetection = React.useCallback<CollisionDetection>((args) => {
    if (args.pointerCoordinates) lastPointer.current = args.pointerCoordinates;
    return pointerFirstCollision(args, dragStart.current);
  }, []);

  const matchFilters = React.useCallback(
    (b: Bead) => {
      if (b.issue_type === "epic") return false;
      if (!showArchived && (b.labels ?? []).includes("archived")) return false;
      return matchesFilters(b, filters, humanAllowlist);
    },
    [filters, showArchived, humanAllowlist],
  );

  const visible = React.useMemo(() => beads.filter(matchFilters), [beads, matchFilters]);
  const columns = React.useMemo(
    () =>
      COLUMNS.map((c) => {
        let cards = visible.filter((b) => c.test(b, blockKind(b, index)));
        // Done column: optionally keep only beads closed within the chosen window.
        if (c.id === "done" && doneWindow !== null) {
          const cutoff = now - doneWindow * 86_400_000;
          cards = cards.filter((b) => {
            const t = Date.parse(b.closed_at || b.updated_at || "");
            return Number.isFinite(t) && t >= cutoff;
          });
        }
        return {
          col: c,
          cards: sortBoardCards(cards, boardPrefs.sortMode, orders[c.id]),
        };
      }),
    [visible, index, orders, boardPrefs.sortMode, doneWindow, now],
  );

  // Hide every column that shows no cards (after the filters, the search and the
  // Done window), so the board shows only where work is. Exceptions:
  // - no column has a card: show them all, so the board is never blank;
  // - the user pinned the Blocked column to always show (bead mo3);
  // - a Done window is chosen: Done keeps its window control reachable.
  // Drag logic below still uses the full `columns` set; a hidden column has
  // zero cards, so nothing is ever dragged out of it. During a drag the shown set
  // is the one frozen at drag start.
  const liveShownIds = React.useMemo(() => {
    if (columns.every(({ cards }) => cards.length === 0)) return columns.map(({ col }) => col.id);
    return columns
      .filter(
        ({ col, cards }) =>
          cards.length > 0 ||
          (col.id === "blocked" && boardPrefs.blockedColumn === "always") ||
          (col.id === "done" && doneWindow !== null),
      )
      .map(({ col }) => col.id);
  }, [columns, boardPrefs.blockedColumn, doneWindow]);
  const shownIds = draggingId && frozenShown ? frozenShown : liveShownIds;
  const shownColumns = columns.filter(({ col }) => shownIds.includes(col.id));

  // Which column each visible bead currently sits in (drag targets resolve here).
  const colOfBead = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const { col, cards } of columns) for (const b of cards) m.set(b.id, col.id);
    return m;
  }, [columns]);

  // `over` is a column id (pointer over empty column space), a drop-bar target (a
  // hidden column), or a bead id (over a card).
  function columnUnder(overId: string | null): string | undefined {
    if (!overId) return undefined;
    const barColumn = columnOfDropBarId(overId);
    if (barColumn) return barColumn;
    return COLUMNS.some((c) => c.id === overId) ? overId : colOfBead.get(overId);
  }

  function endDrag() {
    setDraggingId(null);
    setOverColumnId(null);
    setFrozenShown(null);
    dragStart.current = null;
    lastPointer.current = null;
  }

  function onDragStart(e: DragStartEvent) {
    dragStart.current = pointOf(e.activatorEvent);
    // The bar covers the board area from its top edge down to just above the
    // highest column body, so it never covers a card or a column's drop area.
    const area = boardAreaRef.current;
    const bodies = area ? [...area.querySelectorAll("[data-board-column-body]")] : [];
    if (area && bodies.length > 0) {
      const top = Math.min(...bodies.map((b) => b.getBoundingClientRect().top));
      setBarHeight(Math.max(0, Math.floor(top - area.getBoundingClientRect().top - BAR_GAP)));
    }
    setFrozenShown(liveShownIds);
    setDraggingId(String(e.active.id));
  }

  function onDragOver(e: DragOverEvent) {
    setOverColumnId(columnUnder(e.over?.id ? String(e.over.id) : null) ?? null);
  }

  function onDragEnd(e: DragEndEvent) {
    const start = dragStart.current;
    const end = lastPointer.current;
    endDrag();
    if (readOnly) return;
    if (start && end && Math.hypot(end.x - start.x, end.y - start.y) < IN_PLACE_DISTANCE) return;
    const activeId = String(e.active.id);
    const overRaw = e.over?.id ? String(e.over.id) : null;
    if (!overRaw) return;

    const activeCol = colOfBead.get(activeId);
    if (!activeCol) return;

    const overCol = columnUnder(overRaw);
    if (!overCol) return;

    if (overCol !== activeCol) {
      // Cross-column → status change (existing behavior).
      const target = COLUMNS.find((c) => c.id === overCol);
      if (!target || !target.droppable || !target.status) return;
      const bead = index.get(activeId);
      if (!bead || bead.status === target.status) return;
      setStatus.mutate({ id: activeId, status: target.status });
      // The drop sets the column's status, and the card then sits where the column
      // rules put it. Say so when that is another column, so the drop has a result.
      const landing = colOf({ ...bead, status: target.status }, index);
      if (landing && landing !== target.id) {
        const name = COLUMNS.find((c) => c.id === landing)?.name ?? landing;
        const why = blockKind(bead, index) === "gate" ? "waits on a person" : "waits on other work";
        toast(`${bead.id} is now ${target.status}`, {
          description: `It ${why}, so it ${landing === activeCol ? "stays" : "shows"} in ${name}.`,
        });
      }
      return;
    }

    if (boardPrefs.sortMode !== "manual") return;

    // Within-column → reorder + persist the manual order.
    const ids = (columns.find((c) => c.col.id === activeCol)?.cards ?? []).map((b) => b.id);
    const oldIndex = ids.indexOf(activeId);
    const newIndex = overRaw === activeCol ? ids.length - 1 : ids.indexOf(overRaw);
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;
    setOrder.mutate({ columnId: activeCol, ids: arrayMove(ids, oldIndex, newIndex) });
  }

  const draggingBead = draggingId ? index.get(draggingId) : undefined;
  // Advertise only a column that a drop would actually move the card into.
  const sourceColumnId = draggingId ? colOfBead.get(draggingId) : undefined;
  const takesDrop = (c: (typeof COLUMNS)[number]) =>
    c.id !== sourceColumnId && c.droppable && !!c.status && draggingBead?.status !== c.status;
  const dropColumn = COLUMNS.find((c) => c.id === overColumnId && takesDrop(c));
  // While a card is dragged, the hidden columns that would take it are offered in
  // the drop bar. They are not put back into the column row, so nothing on the
  // board moves or resizes when a drag starts. A column whose drop would change
  // nothing (the card already has its status) gets no target.
  const barColumns = draggingId ? COLUMNS.filter((c) => !shownIds.includes(c.id) && takesDrop(c)) : [];

  // Screen-reader announcements in column names and card titles, not raw ids.
  const nameOf = (id: string | number | undefined): string => {
    if (id === undefined) return "nothing";
    const key = String(id);
    const column = COLUMNS.find((c) => c.id === (columnOfDropBarId(key) ?? key));
    if (column) return column.name;
    const card = index.get(key);
    const col = colOfBead.get(key);
    return card ? `${card.title}${col ? ` in ${COLUMNS.find((c) => c.id === col)?.name ?? col}` : ""}` : key;
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}.`,
    onDragOver: ({ active, over }) => `${index.get(String(active.id))?.title ?? active.id} is over ${nameOf(over?.id)}.`,
    onDragEnd: ({ active, over }) => `Dropped ${index.get(String(active.id))?.title ?? active.id} on ${nameOf(over?.id)}.`,
    onDragCancel: ({ active }) => `Moving ${index.get(String(active.id))?.title ?? active.id} was cancelled.`,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-border bg-[var(--surface)] p-[14px_22px]">
        <div className="mr-1 flex flex-col gap-px">
          <h1 className="m-0 text-base font-[650] tracking-[-.01em]">Board</h1>
          <span className="text-[11.5px] text-[var(--text-3)]">
            {visible.length} beads · live from <span className="font-mono">bd list</span>
          </span>
        </div>

        <FilterBar
          filters={filters}
          onChange={setFilters}
          labelOptions={labelOptions}
          assigneeOptions={assigneeOptions}
          showArchived={showArchived}
          onShowArchived={setShowArchived}
          onClearAllAction={clearFilters}
        />

        <label
          className="flex h-9 flex-shrink-0 items-center gap-[7px] rounded-[9px] border border-border bg-[var(--surface-2)] px-[10px] text-[12.5px] text-[var(--text-2)]"
          title={
            boardPrefs.sortMode === "manual"
              ? "Drag to reorder cards or move them between status columns"
              : "Drag between status columns; choose Manual to reorder within a column"
          }
        >
          <span className="font-medium">Sort</span>
          <select
            aria-label="Sort board cards"
            value={boardPrefs.sortMode}
            onChange={(e) =>
              setBoardPrefs({
                ...boardPrefs,
                sortMode: e.target.value as BoardSortMode,
              })
            }
            className="cursor-pointer border-none bg-transparent text-[12.5px] font-semibold text-[var(--text)] outline-none"
          >
            <option value="priority">Priority</option>
            <option value="updated">Recently updated</option>
            <option value="manual">Manual</option>
          </select>
        </label>

        {!readOnly && (
          <button
            onClick={() => openCreate()}
            className="flex h-9 flex-shrink-0 items-center gap-[6px] rounded-[9px] px-[14px] text-[13px] font-[550] text-white"
            style={{ background: "var(--brand)", boxShadow: "0 2px 8px -2px var(--brand)" }}
          >
            <Icon name="plus" size={15} />
            <span>New</span>
          </button>
        )}
      </header>

      {/* The drop bar is positioned against this wrapper, outside the horizontal
          scroller, so it stays put over the header row while the columns scroll. */}
      <div ref={boardAreaRef} className="relative flex min-h-0 flex-1 flex-col">
        {loading && beads.length === 0 ? (
          <div className={BOARD_SCROLL}>
            <div className="text-[13px] text-[var(--text-3)]">Loading beads…</div>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            accessibility={{ announcements }}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onDragCancel={endDrag}
          >
            <div className={BOARD_SCROLL}>
              <div className="flex h-full min-h-0 gap-4">
                {shownColumns.map(({ col, cards }) => (
                  <Column
                    key={col.id}
                    col={col}
                    cards={cards}
                    childCounts={childCounts}
                    manualSort={boardPrefs.sortMode === "manual"}
                    dropTarget={dropColumn?.id === col.id}
                    control={
                      col.id === "done" ? (
                        <select
                          value={doneWindow ?? ""}
                          onChange={(e) =>
                            setDoneWindow(e.target.value === "" ? null : Number(e.target.value))
                          }
                          title="Show only beads closed within this window"
                          className="cursor-pointer rounded-[7px] border border-border bg-[var(--surface-2)] px-[7px] py-[3px] text-[11px] text-[var(--text-2)] outline-none"
                        >
                          <option value="">All time</option>
                          <option value="7">Last 7 days</option>
                          <option value="28">Last 4 weeks</option>
                          <option value="90">Last 3 months</option>
                          <option value="365">Last 12 months</option>
                        </select>
                      ) : undefined
                    }
                  />
                ))}
              </div>
            </div>
            {barColumns.length > 0 && barHeight > 0 && (
              <DropBar columns={barColumns} height={barHeight} dropTargetId={dropColumn?.id} />
            )}
            {/* No drop animation: a cross-column drop has already moved the card, so
                animating the preview toward its old slot would read as a failed move. */}
            <DragOverlay dropAnimation={null}>
              {draggingBead ? (
                <BeadCardOverlay bead={draggingBead} childCount={childCounts.get(draggingBead.id) ?? 0} />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>
    </div>
  );
}
