"use client";

import { useState, useTransition } from "react";

import { previewRule, saveRule, deleteRule } from "@/lib/actions/filters";

type Props = {
  routeId: string;
  initialPrompt: string;
  initialAstJson: string;
  hasApiKey: boolean;
  hasExistingFilter: boolean;
};

export function FilterEditor({
  routeId,
  initialPrompt,
  initialAstJson,
  hasApiKey,
  hasExistingFilter,
}: Props) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [astJson, setAstJson] = useState(initialAstJson);
  const [matchInfo, setMatchInfo] = useState<{
    matched: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCompiling, startCompile] = useTransition();
  const [isSaving, startSave] = useTransition();

  function handleCompile() {
    setError(null);
    setMatchInfo(null);
    startCompile(async () => {
      try {
        const res = await previewRule(routeId, prompt);
        setAstJson(JSON.stringify(res.ast, null, 2));
        setMatchInfo({ matched: res.matchedCount, total: res.totalCount });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function handleSave() {
    setError(null);
    startSave(async () => {
      try {
        const fd = new FormData();
        fd.set("routeId", routeId);
        fd.set("prompt", prompt);
        fd.set("astJson", astJson);
        await saveRule(fd);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function handleDelete() {
    startSave(async () => {
      const fd = new FormData();
      fd.set("routeId", routeId);
      await deleteRule(fd);
      setPrompt("");
      setAstJson("");
      setMatchInfo(null);
    });
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Describe the rule</h2>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder={
            'e.g. "Only charge.succeeded events where amount > $1000 and country is in the EU"'
          }
          className="mt-3 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleCompile}
            disabled={!hasApiKey || !prompt.trim() || isCompiling}
            className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
          >
            {isCompiling ? "Compiling…" : "Compile with Claude"}
          </button>
          {!hasApiKey && (
            <span className="text-xs text-amber-600">
              Add a Claude API key to enable compilation
            </span>
          )}
          {matchInfo && (
            <span className="text-xs text-zinc-500">
              Matches {matchInfo.matched} of your last {matchInfo.total} events
            </span>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
        <div className="border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700">
          Compiled filter AST
        </div>
        <textarea
          value={astJson}
          onChange={(e) => setAstJson(e.target.value)}
          rows={12}
          spellCheck={false}
          placeholder='{ "and": [ { "eq": ["$.type", "charge.succeeded"] } ] }'
          className="w-full resize-y rounded-b-lg bg-transparent p-4 font-mono text-xs focus:outline-none"
        />
      </section>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={!astJson.trim() || isSaving}
          className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
        >
          {isSaving ? "Saving…" : "Save filter"}
        </button>
        {hasExistingFilter && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={isSaving}
            className="text-xs text-red-600 hover:underline"
          >
            Remove filter
          </button>
        )}
      </div>
    </div>
  );
}
