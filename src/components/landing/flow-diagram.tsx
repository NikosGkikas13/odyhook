// Static-data animated flow diagram for the homepage hero.
// Sources fan out to destinations via small bezier lanes; colored dots
// travel each lane on a CSS keyframe (defined in globals.css) so the
// reduced-motion fallback is just CSS, no React state.

const SOURCES = [
  { id: "stripe", label: "stripe.com" },
  { id: "github", label: "github.com" },
  { id: "shopify", label: "shopify.com" },
];
const DESTINATIONS = [
  { id: "api", label: "api.acme.com" },
  { id: "slack", label: "#slack-alerts" },
  { id: "archive", label: "archive.s3" },
];

type FlowStatus = "delivered" | "pending" | "failed";

const ROUTES: { from: number; to: number; status: FlowStatus; dur: number; delay: number }[] = [
  { from: 0, to: 0, status: "delivered", dur: 2600, delay: 0 },
  { from: 0, to: 1, status: "delivered", dur: 3000, delay: 600 },
  { from: 1, to: 0, status: "pending", dur: 3400, delay: 1100 },
  { from: 1, to: 2, status: "delivered", dur: 2800, delay: 1700 },
  { from: 2, to: 1, status: "failed", dur: 3200, delay: 2300 },
  { from: 2, to: 2, status: "delivered", dur: 2700, delay: 300 },
];

const NODE_W = 132;
const NODE_H = 36;
const ROW_YS = [56, 162, 268];
const SRC_X = 16;
const DST_X = 364;
const SRC_OUT_X = SRC_X + NODE_W + 4;
const DST_IN_X = DST_X - 4;
const VB_W = 512;

function FlowNode({
  x,
  y,
  label,
  kind,
}: {
  x: number;
  y: number;
  label: string;
  kind: "source" | "dest";
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={NODE_W}
        height={NODE_H}
        rx={6}
        fill="var(--bg-elevated)"
        stroke="var(--border-1)"
      />
      <circle
        cx={kind === "source" ? x + 14 : x + NODE_W - 14}
        cy={y + NODE_H / 2}
        r={3}
        fill={kind === "source" ? "var(--fg-3)" : "var(--status-delivered)"}
      />
      <text
        x={kind === "source" ? x + 26 : x + NODE_W - 26}
        y={y + NODE_H / 2 + 4}
        textAnchor={kind === "source" ? "start" : "end"}
        fontFamily="var(--font-mono)"
        fontSize={12}
        fill="var(--fg-2)"
      >
        {label}
      </text>
    </g>
  );
}

function TailRow({
  status,
  src,
  to,
  t,
  code,
}: {
  status: FlowStatus;
  src: string;
  to: string;
  t: string;
  code?: string;
}) {
  return (
    <div className="flow-tail-row">
      <span aria-label={status} className={`dot dot--${status}`} />
      <code className="flow-tail-src">{src}</code>
      <span className="flow-tail-arr">→</span>
      <code className="flow-tail-to">{to}</code>
      <span className="flow-tail-spacer" />
      {code && <span className="flow-tail-code">HTTP {code}</span>}
      <span className="flow-tail-time">{t} ago</span>
    </div>
  );
}

export function FlowDiagram() {
  return (
    <div className="flow-card">
      <div className="flow-card-head">
        <span>live event flow</span>
        <span className="flow-card-live">
          <span aria-hidden className="dot dot--in-flight" /> streaming
        </span>
      </div>
      <div className="flow-svg-wrap" aria-hidden="true">
        <svg
          viewBox={`0 0 ${VB_W} 324`}
          width="100%"
          height={324}
          preserveAspectRatio="xMidYMid meet"
          className="flow-svg"
        >
          {ROUTES.map((r, i) => {
            const x1 = SRC_OUT_X;
            const x2 = DST_IN_X;
            const y1 = ROW_YS[r.from];
            const y2 = ROW_YS[r.to];
            const midX = (x1 + x2) / 2;
            const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
            return <path key={i} d={d} fill="none" stroke="var(--border-1)" strokeWidth={1} />;
          })}
          {SOURCES.map((s, i) => (
            <FlowNode key={s.id} x={SRC_X} y={ROW_YS[i] - NODE_H / 2} label={s.label} kind="source" />
          ))}
          {DESTINATIONS.map((d, i) => (
            <FlowNode key={d.id} x={DST_X} y={ROW_YS[i] - NODE_H / 2} label={d.label} kind="dest" />
          ))}
        </svg>

        <div className="flow-dots">
          {ROUTES.map((r, i) => {
            const dx = DST_IN_X - SRC_OUT_X;
            const dyStart = ROW_YS[r.from];
            const dyEnd = ROW_YS[r.to];
            const style = {
              left: `${(SRC_OUT_X / VB_W) * 100}%`,
              top: `${dyStart}px`,
              "--dx": `${(dx / VB_W) * 100}%`,
              "--dy": `${dyEnd - dyStart}px`,
              animationDuration: `${r.dur}ms`,
              animationDelay: `${r.delay}ms`,
            } as React.CSSProperties;
            return <span key={i} className={`flow-dot flow-dot--${r.status}`} style={style} />;
          })}
        </div>
      </div>

      <div className="flow-tail">
        <TailRow status="delivered" src="stripe.com" to="api.acme.com" t="2s" />
        <TailRow status="delivered" src="github.com" to="archive.s3" t="4s" />
        <TailRow status="failed" src="shopify.com" to="#slack-alerts" t="6s" code="503" />
        <TailRow status="delivered" src="stripe.com" to="#slack-alerts" t="9s" />
      </div>
    </div>
  );
}
