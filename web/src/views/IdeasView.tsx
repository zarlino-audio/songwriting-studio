import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";

const KINDS = ["hook", "lyric", "title", "concept", "one-liner", "metaphor", "story", "melody", "voice-note"];

/** Idea Bank (spec §29) — a separate workspace that feeds songs. */
export default function IdeasView({
  onError,
  notify,
  onNavigate,
}: {
  onError: (message: string) => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
  onNavigate: (path: string) => void;
}) {
  const [ideas, setIdeas] = useState<{ id: string; kind: string; text: string; tags: string[]; createdAt: string }[]>([]);
  const [kind, setKind] = useState("hook");
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<string>("");

  const load = useCallback(async () => {
    try {
      const result = await api.listIdeas();
      setIdeas(result.ideas);
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not load ideas");
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!text.trim()) return;
    try {
      await api.createIdea({ kind, text: text.trim() });
      setText("");
      notify("Idea saved");
      await load();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not save the idea");
    }
  };

  const visible = filter ? ideas.filter((idea) => idea.kind === filter) : ideas;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Idea bank</h1>
        <p className="text-sm text-studio-400">Hooks, concepts, one-liners. Pull them into a song when they fit.</p>
      </header>

      <section className="card flex flex-wrap items-end gap-2">
        <div>
          <label className="label" htmlFor="kind">
            Kind
          </label>
          <select id="kind" className="input w-40" value={kind} onChange={(event) => setKind(event.target.value)}>
            {KINDS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[240px] flex-1">
          <label className="label" htmlFor="idea-text">
            Idea
          </label>
          <input
            id="idea-text"
            className="input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
            }}
            placeholder="Still hungry even after the table is full"
          />
        </div>
        <button className="btn-primary" onClick={() => void save()}>
          Save idea
        </button>
      </section>

      <div className="flex flex-wrap gap-1">
        <button className={filter === "" ? "chip-active btn-xs" : "chip btn-xs"} onClick={() => setFilter("")}>
          all
        </button>
        {KINDS.map((entry) => (
          <button key={entry} className={filter === entry ? "chip-active btn-xs" : "chip btn-xs"} onClick={() => setFilter(entry)}>
            {entry}
          </button>
        ))}
      </div>

      <section className="flex flex-col gap-2">
        {visible.map((idea) => (
          <div key={idea.id} className="card flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm">{idea.text}</div>
              <div className="mt-1 text-xs text-studio-400">
                <span className="section-kind mr-2">{idea.kind}</span>
                {new Date(idea.createdAt).toLocaleString()}
              </div>
            </div>
            <div className="flex gap-1">
              <button
                className="btn btn-xs"
                onClick={async () => {
                  await navigator.clipboard.writeText(idea.text);
                  notify("Copied", "info");
                }}
              >
                ⧉
              </button>
              <button
                className="btn btn-xs"
                onClick={async () => {
                  await api.deleteIdea(idea.id);
                  await load();
                }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="text-sm text-studio-400">
            Nothing here yet. Ideas you save survive between sessions — <button className="underline" onClick={() => onNavigate("/songs")}>open a song</button> when you want to use one.
          </p>
        )}
      </section>
    </div>
  );
}
