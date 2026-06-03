import type { Metadata } from "next";

import { ComparisonPage } from "@/components/marketing/comparison-page";
import { getComparison } from "@/lib/marketing/comparisons";

const data = getComparison("hookdeck")!;

export const metadata: Metadata = {
  title: "Odyhook vs Hookdeck — webhook routing compared",
  description:
    "An honest, sourced comparison of Odyhook (self-hosted, flat-cost, BYOK AI) and Hookdeck's Event Gateway. Where each one fits.",
};

export default function VsHookdeckPage() {
  return <ComparisonPage data={data} />;
}
