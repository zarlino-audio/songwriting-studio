import { useState } from "react";
import { api, ApiError, type AiSuggestionResponseEnvelope } from "../api";

export const AI_MODES: { mode: string; label: string; hint: string }[] = [
  { mode: "concept", label: "Concept", hint: "Directions the song could take" },
  { mode: "hook", label: "Hook", hint: "Hook lines that can carry the section" },
  { mode: "rhyme", label: "Rhyme", hint: "Stronger / near rhyme options" },
  { mode: "cadence", label: "Cadence", hint: "Different rhythmic approaches" },
  { mode: "metaphor", label: "Metaphor", hint: "Concrete images for the idea" },
  { mode: "story", label: "Story", hint: "Where the narrative should go" },
  { mode: "contrast", label: "Contrast", hint: "A contrasting move for this section" },
  { mode: "melody", label: "Melody", hint: "Contour and syllable density ideas" },
  { mode: "rewrite", label: "Rewrite", hint: "Keep the meaning, improve the writing" },
  { mode: "simplify", label: "Simplify", hint: "More natural, more speakable" },
  { mode: "intensify", label: "Intensify", hint: "Make it hit harder" },
  { mode: "personalize", label: "Personalize", hint: "Move it toward your voice" },
  { mode: "critique", label: "Challenge me", hint: "Honest craft critique with fixes" },
];

/**
 * AI collaborator panel (spec §11–§14, §37–§40).
 *
 * The AI never edits the artist's text: it returns options, and only an explicit
 * action by the artist inserts one. Accept/reject is recorded as writing memory.
 */
export default function AiPanel({
  songId,
  sectionId,
  selection,
  onInsert,
  onError,
  notify,
}: {
  songId: string;
  sectionId: string | null;
  selection: string;
  onInsert: (text: string) => void;
  onError: (message: string) => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}) {
  const [mode, setMode] = useState("hook");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiSuggestionResponseEnvelope | null>(null);

  const run = async (refresh = false) => {
    setBusy(true);
    try {
      const response = await api.suggest({
        songId,
        sectionId,
        mode,
        instruction: instruction.trim() || undefined,
        selection: selection.trim() || undefined,
        refresh,
      });
      setResult(response);
      void api
        .aiStatus()
        .catch(() => undefined)
        .then(() => undefined);
    } catch (error) {
      onError(error instanceof ApiError ? `${error.message}${error.detail ? ` — ${error.detail}` : ""}` : "AI request failed");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (accepted: boolean, optionIndex: number, text: string) => {
    if (!result) return;
    try {
      await api.aiFeedback({
        requestId: result.requestId,
        optionIndex,
        accepted,
        chosenText: accepted ? text : undefined,
      });
      if (accepted) {
        onInsert(text);
        notify("Inserted — the original is untouched in your version history");
      } else {
        notify("Noted — this is remembered for next time", "info");
      }
    } catch {
      // feedback is best-effort
    }
  };

  return (
    <aside className="card flex h-full flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-studio-300">AI collaborator</h2>
        <p className="mt-1 text-xs text-studio-400">
          Suggestions only — nothing changes until you keep it.
        </p>
      </div>

      <div className="flex flex-wrap gap-1">
        {AI_MODES.map((entry) => (
          <button
            key={entry.mode}
            title={entry.hint}
            className={mode === entry.mode ? "chip-active btn-xs" : "chip btn-xs"}
            onClick={() => setMode(entry.mode)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div>
        <label className="label" htmlFor="ai-instruction">
          What do you want?
        </label>
        <textarea
          id="ai-instruction"
          className="input h-16 resize-none"
          placeholder='e.g. "make the chorus feel like I finally made it, but still hungry"'
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </div>

      <div className="rounded-lg bg-studio-950/60 p-2 text-xs text-studio-400">
        <div className="mb-1 font-semibold uppercase tracking-wide text-studio-300">Context sent</div>
        {selection.trim() ? (
          <div className="line-clamp-3 whitespace-pre-wrap font-mono text-[11px]">{selection.slice(0, 320)}</div>
        ) : (
          <div>Current section text (nothing highlighted).</div>
        )}
      </div>

      <div className="flex gap-2">
        <button className="btn-primary btn-xs flex-1" onClick={() => void run(false)} disabled={busy}>
          {busy ? "Thinking…" : "Suggest"}
        </button>
        <button className="btn btn-xs" onClick={() => void run(true)} disabled={busy} title="Ignore the cache and ask again">
          ↻
        </button>
      </div>

      {result && (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
          <div className="text-xs text-studio-300">
            <div className="font-semibold">{result.suggestion.title}</div>
            {result.suggestion.framing && <p className="mt-1 text-studio-400">{result.suggestion.framing}</p>}
            <div className="mt-1 flex flex-wrap gap-1">
              <span className="chip">{result.meta.model}</span>
              <span className="chip">{result.meta.tier}</span>
              {result.meta.cached && <span className="chip">cached</span>}
              <span className="chip">{result.meta.latencyMs}ms</span>
            </div>
          </div>

          {result.suggestion.options.map((option, index) => (
            <div key={option.id} className="card-tight">
              <p className="whitespace-pre-wrap text-sm">{option.text}</p>
              {option.why && <p className="mt-1 text-xs text-studio-400">{option.why}</p>}
              <div className="mt-2 flex gap-1">
                <button className="btn btn-xs" onClick={() => void decide(true, index, option.text)}>
                  ✓ Keep
                </button>
                <button className="btn btn-xs" onClick={() => void decide(false, index, option.text)}>
                  ✕ Discard
                </button>
                <button className="btn btn-xs" onClick={() => void navigator.clipboard.writeText(option.text)}>
                  ⧉ Copy
                </button>
              </div>
            </div>
          ))}

          {result.suggestion.cautions.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-amber-300">
              {result.suggestion.cautions.map((caution) => (
                <li key={caution}>{caution}</li>
              ))}
            </ul>
          )}
          {result.suggestion.notes.length > 0 && (
            <ul className="list-disc pl-5 text-xs text-studio-400">
              {result.suggestion.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          {result.suggestion.raw && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-studio-950/60 p-2 text-[11px] text-studio-300">
              {result.suggestion.raw}
            </pre>
          )}
        </div>
      )}

      {!result && !busy && (
        <div className="text-xs text-studio-400">
          Pick a mode, add an instruction if you have one, then ask. Options arrive as alternatives — never a finished song.
        </div>
      )}
    </aside>
  );
}
