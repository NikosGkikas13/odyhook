"use client";

import * as RSelect from "@radix-ui/react-select";

// Tailwind-styled wrapper around @radix-ui/react-select. Drop-in replacement
// for native <select> in places we care about popup positioning — Radix
// renders the popup in a portal, anchored precisely under the trigger,
// instead of the macOS-native popup that drifts left for the checkmark column.

function ChevronDownIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8l3.5 3.5L13 5" />
    </svg>
  );
}

export type SelectOption = {
  value: string;
  label: string;
};

export function Select({
  value,
  onValueChange,
  options,
  ariaLabel,
  placeholder,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  options: SelectOption[];
  ariaLabel: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <RSelect.Root value={value} onValueChange={onValueChange}>
      <RSelect.Trigger
        aria-label={ariaLabel}
        className={`inline-flex h-9 min-w-0 items-center justify-between gap-2 rounded-md border border-zinc-200 bg-white px-3 text-sm text-zinc-900 hover:bg-zinc-50 data-[state=open]:bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:data-[state=open]:bg-zinc-800 ${className ?? ""}`}
      >
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon className="text-zinc-400 dark:text-zinc-500">
          <ChevronDownIcon />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-zinc-200 bg-white shadow-md dark:border-zinc-700 dark:bg-zinc-900"
        >
          <RSelect.Viewport className="p-1">
            {options.map((opt) => (
              <RSelect.Item
                key={opt.value}
                value={opt.value}
                className="relative flex h-8 cursor-pointer select-none items-center rounded-sm pl-7 pr-3 text-sm text-zinc-900 outline-none data-[highlighted]:bg-zinc-100 dark:text-zinc-100 dark:data-[highlighted]:bg-zinc-800"
              >
                <RSelect.ItemIndicator className="absolute left-2 inline-flex h-4 w-4 items-center justify-center">
                  <CheckIcon />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{opt.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}
