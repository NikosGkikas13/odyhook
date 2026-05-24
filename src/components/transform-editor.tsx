"use client";

import { useState, useTransition } from "react";

import {
  generateForRoute,
  saveTransformation,
  deleteTransformation,
} from "@/lib/actions/transformations";

type Props = {
  routeId: string;
  initialPrompt: string;
  initialCode: string;
  initialSampleInput: string;
  initialSampleOutput: string;
  hasApiKey: boolean;
};

export function TransformEditor({
  routeId,
  initialPrompt,
  initialCode,
  initialSampleInput,
  initialSampleOutput,
  hasApiKey,
}: Props) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [code, setCode] = useState(initialCode);
  const [sampleInput, setSampleInput] = useState(initialSampleInput);
  const [preview, setPreview] = useState<string>(initialSampleOutput);
  const [error, setError] = useState<string | null>(null);
  const [isGenerating, startGenerate] = useTransition();
  const [isSaving, startSave] = useTransition();

  function handleGenerate() {
    setError(null);
    startGenerate(async () => {
      try {
        const res = await generateForRoute(routeId, prompt);
        setCode(res.codeJs);
        setSampleInput(JSON.stringify(res.sampleInput, null, 2));
        if (res.previewOk) {
          setPreview(JSON.stringify(res.previewOutput, null, 2));
        } else {
          setPreview("");
          setError(res.previewError ?? "unknown sandbox error");
        }
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
        fd.set("codeJs", code);
        fd.set("sampleInput", sampleInput || "null");
        await saveTransformation(fd);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function handleDelete() {
    startSave(async () => {
      const fd = new FormData();
      fd.set("routeId", routeId);
      await deleteTransformation(fd);
      setPrompt("");
      setCode("");
      setPreview("");
    });
  }

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-6 dark:border-zinc-700 dark:bg-zinc-900">
        <h2 className="text-sm font-medium">Describe the target shape</h2>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder={
            'e.g. "Keep only customer email, total in dollars, and a CSV of line item names. Drop everything else."'
          }
          className="mt-3 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!hasApiKey || !prompt.trim() || isGenerating}
            className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
          >
            {isGenerating ? "Generating…" : "Generate with Claude"}
          </button>
          {!hasApiKey && (
            <span className="text-xs text-amber-600">
              Add a Claude API key to enable generation
            </span>
          )}
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2 dark:border-zinc-700">
            <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              Generated / edited code
            </span>
          </div>
          <textarea
            value={code}
            onChange={(e) => setCode(e.target.value)}
            rows={16}
            spellCheck={false}
            placeholder="(event) => ({ /* … */ })"
            className="w-full resize-y rounded-b-lg bg-transparent p-4 font-mono text-xs focus:outline-none"
          />
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
            <div className="border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700">
              Sample input
            </div>
            <textarea
              value={sampleInput}
              onChange={(e) => setSampleInput(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder='{ "type": "charge.succeeded", ... }'
              className="w-full resize-y rounded-b-lg bg-transparent p-4 font-mono text-xs focus:outline-none"
            />
          </div>
          <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
            <div className="border-b border-zinc-200 px-4 py-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-700">
              Preview output
            </div>
            <pre className="max-h-48 overflow-auto rounded-b-lg p-4 font-mono text-xs text-emerald-700 dark:text-emerald-400">
              {preview || "— run generate or save to see preview —"}
            </pre>
          </div>
        </div>
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
          disabled={!code.trim() || isSaving}
          className="btn-primary-ody inline-flex h-9 items-center rounded-md px-4 text-sm font-medium disabled:opacity-60"
        >
          {isSaving ? "Saving…" : "Save transformation"}
        </button>
        {initialCode && (
          <button
            type="button"
            onClick={handleDelete}
            disabled={isSaving}
            className="text-xs text-red-600 hover:underline"
          >
            Remove transformation
          </button>
        )}
      </div>
    </div>
  );
}
