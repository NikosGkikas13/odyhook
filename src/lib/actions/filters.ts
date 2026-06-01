"use server";

import { revalidatePath } from "next/cache";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { compileFilterForSource } from "@/lib/services/filters";
import { setRouteFilter, clearRouteFilter } from "@/lib/services/routes";
import { validateFilterAst, type FilterAst } from "@/lib/filters/evaluator";

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) throw new Error("unauthorized");
  return session.user.id;
}

async function loadRoute(userId: string, routeId: string) {
  const route = await prisma.route.findFirst({
    where: { id: routeId, source: { userId } },
  });
  if (!route) throw new Error("route not found");
  return route;
}

/**
 * Preview a natural-language rule for a route: compile it with Claude and
 * return the AST + match counts, but DO NOT persist it. The editor UI calls
 * this for the "matches N of last 50" sanity check before saving.
 */
export async function previewRule(
  routeId: string,
  prompt: string,
): Promise<{
  ast: FilterAst;
  matchedCount: number;
  totalCount: number;
}> {
  const userId = await requireUserId();
  const route = await loadRoute(userId, routeId);
  return compileFilterForSource(userId, route.sourceId, prompt);
}

/**
 * Persist a filter against a route. Accepts either:
 *   - a JSON-stringified AST (already validated by previewRule), or
 *   - an NL prompt to compile first.
 * If `astJson` is provided, it takes precedence over `prompt`.
 */
export async function saveRule(formData: FormData) {
  const userId = await requireUserId();
  const routeId = String(formData.get("routeId"));
  const prompt = String(formData.get("prompt") ?? "").trim();
  const astJson = String(formData.get("astJson") ?? "").trim();

  await loadRoute(userId, routeId);

  let ast: FilterAst;
  if (astJson) {
    try {
      ast = validateFilterAst(JSON.parse(astJson));
    } catch (e) {
      throw new Error(
        `invalid AST: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else if (prompt) {
    const preview = await previewRule(routeId, prompt);
    ast = preview.ast;
  } else {
    throw new Error("must provide prompt or astJson");
  }

  const saved = await setRouteFilter(userId, routeId, ast, prompt || null);
  if (!saved) throw new Error("route not found");

  revalidatePath(`/routes/${routeId}/filter`);
  revalidatePath("/routes");
}

export async function deleteRule(formData: FormData) {
  const userId = await requireUserId();
  const routeId = String(formData.get("routeId"));
  await loadRoute(userId, routeId);
  await clearRouteFilter(userId, routeId);
  revalidatePath(`/routes/${routeId}/filter`);
  revalidatePath("/routes");
}
