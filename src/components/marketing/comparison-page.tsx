import type { Comparison, CellValue } from "@/lib/marketing/comparisons";

const MARK: Record<CellValue, string> = {
  yes: "✓",
  no: "—",
  partial: "~",
};

export function ComparisonPage({ data }: { data: Comparison }) {
  return (
    <>
      <h1 className="marketing-h1">Odyhook vs {data.competitor}</h1>
      <p className="marketing-lede">{data.positioning}</p>
      <p className="marketing-lede" style={{ fontSize: "0.85rem", opacity: 0.7 }}>
        Comparison as of {data.asOf}. {data.competitor} facts are sourced below;
        they may change — check the linked pages for the latest.
      </p>

      <div className="docs-prose" style={{ marginTop: "2rem" }}>
        <table>
          <thead>
            <tr>
              <th>Capability</th>
              <th>Odyhook</th>
              <th>{data.competitor}</th>
            </tr>
          </thead>
          <tbody>
            {data.features.map((row) => (
              <tr key={row.capability}>
                <td>{row.capability}</td>
                <td>
                  {MARK[row.odyhook.value]}
                  {row.odyhook.note ? ` ${row.odyhook.note}` : ""}
                </td>
                <td>
                  {MARK[row.competitor.value]}
                  {row.competitor.note ? ` ${row.competitor.note}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="marketing-h1" style={{ fontSize: "1.5rem", marginTop: "2.5rem" }}>
        Where {data.competitor} is stronger
      </h2>
      <ul className="docs-prose">
        {data.competitorStrengths.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "2rem",
          marginTop: "2.5rem",
        }}
      >
        <div>
          <h2 className="marketing-h1" style={{ fontSize: "1.25rem" }}>
            Pick Odyhook if
          </h2>
          <ul className="docs-prose">
            {data.pickOdyhookIf.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
        <div>
          <h2 className="marketing-h1" style={{ fontSize: "1.25rem" }}>
            Pick {data.competitor} if
          </h2>
          <ul className="docs-prose">
            {data.pickCompetitorIf.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      </div>

      <p className="marketing-lede" style={{ fontSize: "0.85rem", marginTop: "2.5rem" }}>
        Sources:{" "}
        {data.sources.map((s, i) => (
          <span key={s.url}>
            {i > 0 ? " · " : ""}
            <a href={s.url}>{s.label}</a>
          </span>
        ))}
      </p>
    </>
  );
}
