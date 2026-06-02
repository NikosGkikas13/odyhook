import Image from "next/image";
import Link from "next/link";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { FlowDiagram } from "@/components/landing/flow-diagram";
import { ThemeToggle } from "@/components/theme-toggle";

export const dynamic = "force-dynamic";

// Marketing landing page. Visual centerpiece is the animated flow diagram
// (real-product shape: sources → routes → destinations, status-colored
// dots traveling each lane). Color tokens come from globals.css so the
// page matches the rest of the app and inherits the dark-mode treatment.

async function getEventsLastHour(): Promise<number | null> {
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    return await prisma.event.count({ where: { receivedAt: { gte: since } } });
  } catch {
    // Marketing visitors shouldn't see a 500 if the DB is briefly unavailable.
    return null;
  }
}

export default async function Home() {
  const [session, eventsLastHour] = await Promise.all([
    auth(),
    getEventsLastHour(),
  ]);
  const signedIn = !!session?.user;

  return (
    <main className="landing-v2">
      <section className="landing-hero">
        <div className="landing-hero-copy">
          <p className="landing-eyebrow">
            <Image
              src="/odyhook.png"
              alt="Odyhook"
              width={120}
              height={120}
              priority
              style={{ background: "#fafafa", borderRadius: 4, padding: 2 }}
            />
            {/* <span className="landing-eyebrow-sep">/</span>
            webhook proxy */}
          </p>
          <h1 className="landing-h1">
            Webhooks that don&rsquo;t
            <br />
            silently fail.
          </h1>
          <p className="landing-lede">
            Ingest every event. Log it forever. Forward it anywhere. Retry on
            failure. Replay with one click.
          </p>
          <div className="landing-cta-row">
            <Link
              href={signedIn ? "/sources" : "/signin"}
              className="btn-primary-ody inline-flex h-11 items-center rounded-md px-5 text-sm font-medium shadow-sm"
            >
              {signedIn ? "Open dashboard" : "Sign in"}
            </Link>
            <a href="#how" className="landing-secondary-link">
              See how it works <span aria-hidden>→</span>
            </a>
          </div>
          {eventsLastHour !== null && (
            <p className="landing-livecount">
              <span aria-hidden className="dot dot--delivered" />
              <span>
                <strong>{eventsLastHour.toLocaleString()}</strong> event
                {eventsLastHour === 1 ? "" : "s"} delivered in the last hour
              </span>
            </p>
          )}
        </div>

        <div className="landing-hero-art">
          <FlowDiagram />
        </div>
      </section>

      <section className="landing-features" id="how">
        <div className="feature">
          <p className="feature-eyebrow">01 / ingest</p>
          <h3 className="feature-title">Every event, stored raw</h3>
          <p className="feature-body">
            One ingest URL per source. Body, headers, signature, timestamp —
            kept in Postgres forever. Replay any event, any time.
          </p>
        </div>
        <div className="feature">
          <p className="feature-eyebrow">02 / retry</p>
          <h3 className="feature-title">Exponential backoff, no babysitting</h3>
          <p className="feature-body">
            10s, 30s, 2m, 10m, 1h, 6h. Failed deliveries retry on their own;
            exhausted ones stay visible for one-click replay.
          </p>
        </div>
        <div className="feature">
          <p className="feature-eyebrow">03 / transform</p>
          <h3 className="feature-title">AI-compiled filters and rewrites</h3>
          <p className="feature-body">
            Describe a filter or payload reshape in one sentence; it compiles to
            JS that runs in a QuickJS sandbox before forwarding.
          </p>
        </div>
      </section>

      <section className="landing-snippet">
        <div className="landing-snippet-head">
          <span>point a webhook at your source URL</span>
          <span className="snippet-status">
            <span aria-hidden className="dot dot--delivered" /> received in &lt;
            80ms
          </span>
        </div>
        <pre className="landing-snippet-pre">
          <code>
            {`$ curl https://odyhook.dev/api/ingest/src_8f2a91b3 \\
    -H "stripe-signature: t=1738094412,v1=..." \\
    -H "content-type: application/json" \\
    -d @event.json

`}
            <span className="snippet-out">
              {`→ evt_01HVQ9G7XK   stripe.com → api.acme.com   delivered   42ms`}
            </span>
          </code>
        </pre>
      </section>

      <footer className="landing-footer">
        <Image
          src="/c60f052d-1a1f-461a-9527-c782a250f441__1_-removebg-preview.png"
          alt="Odyhook"
          width={24}
          height={24}
          style={{ background: "white", borderRadius: 4, padding: 2 }}
        />
        <span className="landing-footer-sep">·</span>
        <span>Webhooks that don&rsquo;t silently fail.</span>
        <span className="landing-footer-spacer" />
        <Link href="/docs" className="landing-footer-link">Docs</Link>
        <Link href="/use-cases" className="landing-footer-link">Use cases</Link>
        <Link href="/pricing" className="landing-footer-link">Pricing</Link>
        <Link href="/changelog" className="landing-footer-link">Changelog</Link>
        <ThemeToggle />
      </footer>
    </main>
  );
}
