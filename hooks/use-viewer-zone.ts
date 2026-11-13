"use client";
import * as React from "react";
import {
  NO_ZONE, ZONE_REFRESH_MS, loadViewerZone, sameOriginPath, subscribeViewerZone, viewerZone,
  type ViewerZone,
} from "@/lib/viewer-zone";

/**
 * The zone the board shows times in (lib/viewer-zone.ts, agentwatch board
 * age-65t). A change of the zone renders the caller again, so every component
 * that writes a time from data reads it here and passes it to formatDateTime.
 */
export function useViewerZone(): ViewerZone {
  return React.useSyncExternalStore(subscribeViewerZone, viewerZone, () => NO_ZONE);
}

/**
 * Read the zone from the host's URL (meta.viewerZoneUrl) at load and every 15
 * minutes, and when the page comes back into view after at least that long (a
 * timer in a hidden tab may not run). No URL: the browser's own zone.
 */
export function useViewerZoneLoader(url: string | null | undefined): void {
  const path = sameOriginPath(url);
  React.useEffect(() => {
    if (!path) return;
    let last = Date.now();
    const read = () => {
      last = Date.now();
      void loadViewerZone(path);
    };
    read();
    const timer = window.setInterval(read, ZONE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= ZONE_REFRESH_MS) read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path]);
}
