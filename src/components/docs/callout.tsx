// Server component — a styled note/warning box for docs. Classes are defined
// in the .docs-callout block of globals.css.
export function Callout({
  type = "note",
  children,
}: {
  type?: "note" | "warning";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`docs-callout docs-callout--${type}`}
      role={type === "warning" ? "alert" : "note"}
    >
      <div className="docs-callout-body">{children}</div>
    </div>
  );
}
