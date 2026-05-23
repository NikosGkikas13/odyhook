"use client";

import { useState, useTransition } from "react";
import { toggleRoute } from "@/lib/actions/routes";

interface RouteToggleProps {
  sourceId: string;
  destinationId: string;
  enabled: boolean;
  label: string;
}

export function RouteToggle({
  sourceId,
  destinationId,
  enabled: initialEnabled,
  label,
}: RouteToggleProps) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [flashing, setFlashing] = useState(false);
  const [, startTransition] = useTransition();

  function handleClick() {
    const wasEnabled = enabled;
    const nowEnabled = !wasEnabled;
    setEnabled(nowEnabled);

    if (nowEnabled) {
      // Restart animation cleanly on rapid re-clicks.
      setFlashing(false);
      requestAnimationFrame(() => setFlashing(true));
    } else {
      setFlashing(false);
    }

    const data = new FormData();
    data.set("sourceId", sourceId);
    data.set("destinationId", destinationId);
    startTransition(async () => {
      await toggleRoute(data);
    });
  }

  return (
    <button
      type="button"
      aria-label={label}
      onClick={handleClick}
      onAnimationEnd={(e) => {
        if (e.animationName === "rt-track-flash") setFlashing(false);
      }}
      style={{ position: "relative" }}
      className={[
        "inline-flex h-6 w-10 items-center rounded-full border text-xs font-medium transition-colors",
        enabled && !flashing
          ? "border-emerald-500 bg-emerald-500"
          : enabled && flashing
            ? "rt-toggle-flashing border-emerald-500 bg-emerald-500"
            : "border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900",
      ].join(" ")}
    >
      <span
        className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
          enabled ? "translate-x-5" : "translate-x-0.5 dark:bg-zinc-400"
        }`}
      />
    </button>
  );
}
