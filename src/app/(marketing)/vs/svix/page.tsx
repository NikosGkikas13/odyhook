import type { Metadata } from "next";

import { ComparisonPage } from "@/components/marketing/comparison-page";
import { getComparison } from "@/lib/marketing/comparisons";

const data = getComparison("svix")!;

export const metadata: Metadata = {
  title: "Odyhook vs Svix — webhook routing compared",
  description:
    "An honest, sourced comparison of Odyhook (self-hosted inbound router, BYOK AI) and Svix (open-source webhook sending). Where each one fits.",
};

export default function VsSvixPage() {
  return <ComparisonPage data={data} />;
}
