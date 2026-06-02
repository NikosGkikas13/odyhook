import Link from "next/link";

import { auth } from "@/auth";
import { MarketingHeader } from "@/components/marketing/marketing-header";
import { ThemeToggle } from "@/components/theme-toggle";

// Shared chrome for the public content surfaces (/docs, /use-cases, /pricing,
// /changelog). The landing page lives outside this group so it keeps its
// bespoke full-bleed layout. These routes are public — proxy.ts gates only
// the dashboard, so no auth wiring is needed beyond reading the session to
// pick the header CTA label.
export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const signedIn = !!session?.user;

  return (
    <div className="marketing-shell">
      <MarketingHeader signedIn={signedIn} />
      <main className="marketing-main">{children}</main>
      <footer className="landing-footer">
        <Link href="/">Odyhook</Link>
        <span className="landing-footer-sep">·</span>
        <span>Webhooks that don&rsquo;t silently fail.</span>
        <span className="landing-footer-spacer" />
        <ThemeToggle />
      </footer>
    </div>
  );
}
