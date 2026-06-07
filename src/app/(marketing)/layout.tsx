import Link from "next/link";
import { SessionProvider } from "next-auth/react";

import { MarketingHeader } from "@/components/marketing/marketing-header";
import { ThemeToggle } from "@/components/theme-toggle";

// Shared chrome for the public content surfaces (/docs, /use-cases, /pricing,
// /changelog). The landing page lives outside this group so it keeps its
// bespoke full-bleed layout. These routes are public — proxy.ts gates only the
// dashboard, so no auth wiring is needed here. The only auth-dependent bit is
// the header CTA (Sign in / Dashboard); it reads the session client-side via
// <SessionProvider> so these pages stay fully static (prerendered at build,
// served from the CDN). Reading auth() in this server layout would force the
// whole group into dynamic rendering.
export default function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      <div className="marketing-shell">
        <MarketingHeader />
        <main className="marketing-main">{children}</main>
        <footer className="landing-footer">
          <Link href="/">Odyhook</Link>
          <span className="landing-footer-sep">·</span>
          <span>Webhooks that don&rsquo;t silently fail.</span>
          <span className="landing-footer-spacer" />
          <Link href="/privacy" className="landing-footer-link">Privacy</Link>
          <Link href="/terms" className="landing-footer-link">Terms</Link>
          <ThemeToggle />
        </footer>
      </div>
    </SessionProvider>
  );
}
