"use client";

import { useState } from "react";

// Client component for multi-language code snippets. Usage in MDX:
//   <CodeTabs tabs={[{ label: "Node", code: "..." }, { label: "Python", code: "..." }]} />
export function CodeTabs({
  tabs,
}: {
  tabs: { label: string; code: string }[];
}) {
  const [active, setActive] = useState(0);
  return (
    <div className="docs-codetabs">
      <div className="docs-codetabs-bar" role="tablist">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            role="tab"
            aria-selected={i === active}
            className={i === active ? "is-active" : undefined}
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <pre className="docs-codetabs-pre">
        <code>{tabs[active]?.code}</code>
      </pre>
    </div>
  );
}
