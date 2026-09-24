import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type SongDetail } from "../api";
import Player, { type PlayerSection } from "../components/Player";
import AiPanel from "../components/AiPanel";
import { analyseLyrics, rhymeKey } from "@shared/core/text";
import type { SongSectionPayload } from "@shared/types";

const KINDS = ["intro", "verse", "pre-chorus", "chorus", "post-chorus", "bridge", "rap", "break", "outro", "custom"];
const RHYME_CLASSES = ["rhyme-0", "rhyme-1", "rhyme-2", "rhyme-3", "rhyme-4"];

/**
 * The songwriting surface (spec §20–§22, §31, §37).
 *
 * Structure panel + lyric editor with live metrics + beat player + AI
 * collaborator. Autosave writes through to D1 and snapshots throttled versions;
 * nothing the AI returns is applied unless the artist keeps it.
 */
export default function SongEditorView({
  songId,
  onNavigate,
  onError,
  notify,
}: {
  songId: string;
  onNavigate: (path: string) => void;
  onError: (message: string) => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}) {
  const [detail, setDetail] = useState<SongDetail | null>(null);
  const [sections, setSections] = useState<SongSectionPayload[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selection, setSelection] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [loopSectionId, setLoopSectionId] = useState<string | null>(null);
  const [showRhymes, setShowRhymes] = useState(true);
  const [versions, setVersions] = useState<{ id: string; versionNo: number; name: string | null; createdAt: string; preview: string }[]>([]);
  const [conceptDraft, setConceptDraft] = useState("");
  const [angles, setAngles] = useState<{ requestId: string; options: { id: string; text: string }[] } | null>(null);
  const dirtyRef = useRef(false);
  const sectionRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});

  const selected = sections.find((section) => section.id === selectedId) ?? sections[0] ?? null;

  const load = useCallback(async () => {
    try {
      const result = await api.getSong(songId);
      setDetail(result);
      setSections(result.sections);
      setSelectedId((current) => current ?? result.sections[0]?.id ?? null);
      setConceptDraft(result.song.concept ?? "");
      const versionList = await api.listVersions(songId);
      setVersions(versionList.versions);
      if (result.beat) {
        try {
          setAudioUrl(await api.beatPlaybackUrl(result.beat.id));
        } catch {
          setAudioError("Playback URL unavailable — the beat may still be uploading");
        }
      }
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not load the song");
    }
  }, [songId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  // --- autosave (spec §45: changes are persisted continuously) -------------
  const save = useCallback(
    async (options: { versionName?: string; createVersion?: boolean } = {}) => {
      if (!detail) return;
      setSaveState("saving");
      try {
        await api.saveSong(songId, {
          sections,
          song: { title: detail.song.title, concept: conceptDraft || null },
          versionName: options.versionName,
          createVersion: options.createVersion,
        });
        dirtyRef.current = false;
        setSaveState("saved");
        const versionList = await api.listVersions(songId);
        setVersions(versionList.versions);
      } catch (error) {
        setSaveState("error");
        onError(error instanceof ApiError ? error.message : "Could not save");
      }
    },
    [conceptDraft, detail, onError, sections, songId],
  );

  useEffect(() => {
    if (!detail || !dirtyRef.current) return;
    const timer = window.setTimeout(() => void save(), 1400);
    return () => window.clearTimeout(timer);
  }, [sections, conceptDraft, detail, save]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save({ createVersion: true, versionName: "Manual save" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // --- metrics -------------------------------------------------------------
  const metrics = useMemo(() => analyseLyrics(sections.map((section) => ({ kind: section.kind, content: section.content }))), [sections]);
  const rhymeByLine = useMemo(() => {
    const map = new Map<string, number>();
    let groupIndex = 0;
    for (const group of metrics.rhymeGroups) {
      for (const lineIndex of group.lineIndexes) map.set(`${lineIndex}`, groupIndex % RHYME_CLASSES.length);
      groupIndex++;
    }
    return { map, keys: metrics.rhymeGroups.map((group) => group.key) };
  }, [metrics.rhymeGroups]);

  const playerSections: PlayerSection[] = useMemo(() => {
    const profile = detail?.profile ?? null;
    if (!profile) return [];
    const barSeconds = (60 / Math.max(profile.bpm, 1)) * profile.rhythm.beats_per_bar;
    const downbeats = profile.rhythm.downbeats;
    const timeForBar = (bar: number): number =>
      downbeats.length > bar && downbeats[bar] !== undefined ? downbeats[bar]! : bar * barSeconds;
    return sections.map((section, index) => ({
      id: section.id ?? `section-${index}`,
      label: section.label ?? section.kind,
      start: timeForBar(section.barStart ?? index * 8),
      end: timeForBar(section.barEnd ?? (index + 1) * 8),
    }));
  }, [detail, sections]);

  const updateSection = (id: string, patch: Partial<SongSectionPayload>) => {
    dirtyRef.current = true;
    setSections((current) => current.map((section) => (section.id === id ? { ...section, ...patch } : section)));
  };

  const moveSection = (fromIndex: number, toIndex: number) => {
    dirtyRef.current = true;
    setSections((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      if (!moved) return current;
      next.splice(toIndex, 0, moved);
      return next.map((section, index) => ({ ...section, position: index }));
    });
  };

  const addSection = (kind: string) => {
    dirtyRef.current = true;
    const id = `sec_${Math.random().toString(36).slice(2, 10)}`;
    setSections((current) => [
      ...current,
      { id, position: current.length, kind, label: kind.charAt(0).toUpperCase() + kind.slice(1), content: "" },
    ]);
    setSelectedId(id);
  };

  const removeSection = (id: string) => {
    dirtyRef.current = true;
    setSections((current) => current.filter((section) => section.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const insertFromAi = (text: string) => {
    if (!selected) return;
    const current = selected.content;
    const next = selection && current.includes(selection) ? current.replace(selection, text) : `${current}${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${text}`;
    updateSection(selected.id ?? "", { content: next });
    setSelection("");
  };

  const restore = async (versionId: string) => {
    try {
      const result = await api.restoreVersion(songId, versionId);
      setSections(result.sections);
      notify(`Restored version ${result.restoredFrom} as v${result.versionNo}`);
      await load();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not restore the version");
    }
  };

  const askForAngles = async () => {
    if (!detail) return;
    try {
      const response = await api.suggest({ songId, mode: "concept", instruction: conceptDraft || undefined, sectionId: null });
      setAngles({ requestId: response.requestId, options: response.suggestion.options.map((option) => ({ id: option.id, text: option.text })) });
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not reach the AI");
    }
  };

  if (!detail) return <div className="text-sm text-studio-400">Loading song…</div>;

  const isEmpty = sections.every((section) => section.content.trim().length === 0);
  const beatIntelligence = detail.profile
    ? {
        headline: `${detail.profile.bpm} BPM · ${detail.profile.key}`,
        energy: detail.profile.energy.overall,
        sections: detail.profile.sections,
      }
    : null;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <button className="btn-ghost btn-xs mb-1" onClick={() => onNavigate("/songs")}>
            ← Songs
          </button>
          <input
            className="w-full max-w-xl rounded-lg bg-transparent text-xl font-semibold tracking-tight outline-none focus:bg-studio-900/60 focus:px-2"
            value={detail.song.title}
            onChange={(event) => {
              dirtyRef.current = true;
              setDetail({ ...detail, song: { ...detail.song, title: event.target.value } });
            }}
          />
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-studio-400">
            <span className={detail.song.status === "complete" ? "pill-ok" : "pill-watch"}>{detail.song.status}</span>
            <span>v{detail.song.currentVersion}</span>
            <span>
              {saveState === "saving" ? "Saving…" : saveState === "error" ? "Save failed" : dirtyRef.current ? "Unsaved changes" : "Saved"}
            </span>
            {detail.beat && <span>beat: {detail.beat.title}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-xs" onClick={() => void save({ createVersion: true, versionName: "Manual save" })}>
            Save version (⌘/Ctrl+S)
          </button>
          <button
            className="btn btn-xs"
            onClick={async () => {
              const next = detail.song.status === "complete" ? "draft" : "complete";
              await api.patchSong(songId, { status: next });
              notify(next === "complete" ? "Song marked complete 🎉" : "Moved back to draft");
              await load();
            }}
          >
            {detail.song.status === "complete" ? "Reopen as draft" : "Mark complete"}
          </button>
          <a className="btn btn-xs" href={api.exportSong(songId, "txt")}>
            Export TXT
          </a>
          <a className="btn btn-xs" href={api.exportSong(songId, "json")}>
            Export JSON
          </a>
        </div>
      </header>

      {isEmpty && (
        <section className="card border-accent/40">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-accent-soft">Write with the beat</h2>
          {beatIntelligence ? (
            <>
              <p className="mt-2 text-lg">{beatIntelligence.headline}</p>
              <div className="mt-2 flex h-12 items-end gap-[1px]">
                {detail.profile?.energy.curve.slice(0, 220).map((value, index) => (
                  <span key={index} className="flex-1 rounded-t bg-accent/60" style={{ height: `${Math.max(4, value * 100)}%` }} />
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {beatIntelligence.sections.map((section, index) => (
                  <span key={`${section.type}-${index}`} className="chip">
                    {section.type} · {Math.round(section.start)}s–{Math.round(section.end)}s · e{section.energy.toFixed(2)}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-studio-300">No analysed beat attached. You can still write freely.</p>
          )}

          <div className="mt-4">
            <label className="label" htmlFor="concept">
              What are you trying to say?
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="concept"
                className="input max-w-xl flex-1"
                value={conceptDraft}
                onChange={(event) => {
                  dirtyRef.current = true;
                  setConceptDraft(event.target.value);
                }}
                placeholder="e.g. I finally got the money but I still have the same hunger"
              />
              <button className="btn" onClick={() => void askForAngles()}>
                Give me angles
              </button>
            </div>
          </div>

          {angles && (
            <div className="mt-3 flex flex-col gap-2">
              {angles.options.map((option) => (
                <div key={option.id} className="card-tight flex items-center justify-between gap-3">
                  <span className="text-sm">{option.text}</span>
                  <span className="flex gap-1">
                    <button
                      className="btn btn-xs"
                      onClick={() => {
                        dirtyRef.current = true;
                        setConceptDraft(option.text);
                        setAngles(null);
                      }}
                    >
                      Use as concept
                    </button>
                    <button
                      className="btn btn-xs"
                      onClick={() => {
                        void api.aiFeedback({ requestId: angles.requestId, accepted: false });
                        setAngles((current) => (current ? { ...current, options: current.options.filter((entry) => entry.id !== option.id) } : current));
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      <Player
        audioUrl={audioUrl}
        profile={detail.profile}
        sections={playerSections}
        loopSectionId={loopSectionId}
        onLoopChange={setLoopSectionId}
        error={audioError}
      />

      <div className="grid gap-4 xl:grid-cols-[200px_minmax(0,1fr)_340px]">
        {/* --- structure ------------------------------------------------- */}
        <aside className="card flex flex-col gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-studio-300">Structure</h2>
          <div className="flex flex-col gap-1">
            {sections.map((section, index) => (
              <div
                key={section.id}
                draggable
                onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const from = Number(event.dataTransfer.getData("text/plain"));
                  if (Number.isFinite(from) && from !== index) moveSection(from, index);
                }}
                className={`group flex cursor-grab items-center gap-1 rounded-lg px-2 py-1 text-sm ${
                  selected?.id === section.id ? "bg-accent/20 text-accent-soft" : "hover:bg-studio-800"
                }`}
              >
                <span className="text-studio-500">⠿</span>
                <button className="min-w-0 flex-1 truncate text-left" onClick={() => setSelectedId(section.id ?? null)}>
                  {section.label ?? section.kind}
                </button>
                <button className="text-studio-500 opacity-0 transition group-hover:opacity-100" onClick={() => removeSection(section.id ?? "")}>
                  ✕
                </button>
              </div>
            ))}
          </div>
          <select
            className="input mt-1"
            value=""
            onChange={(event) => {
              if (event.target.value) addSection(event.target.value);
            }}
          >
            <option value="">+ Add section</option>
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </aside>

        {/* --- editor ---------------------------------------------------- */}
        <section className="card flex min-h-[420px] flex-col gap-3">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="input w-40"
                  value={KINDS.includes(selected.kind) ? selected.kind : "custom"}
                  onChange={(event) => updateSection(selected.id ?? "", { kind: event.target.value })}
                >
                  {KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
                <input
                  className="input w-52"
                  value={selected.label ?? ""}
                  placeholder="Label (e.g. Verse 1)"
                  onChange={(event) => updateSection(selected.id ?? "", { label: event.target.value })}
                />
                <label className="flex items-center gap-1 text-xs text-studio-300">
                  <input type="checkbox" checked={showRhymes} onChange={(event) => setShowRhymes(event.target.checked)} />
                  Rhyme + syllable gutter
                </label>
                <span className="chip ml-auto">
                  {selectedSyllables(selected.content)} syllables · {selected.content.split("\n").filter((line) => line.trim()).length} lines
                </span>
              </div>

              <div className="flex min-h-0 flex-1 gap-2">
                <textarea
                  ref={(node) => {
                    if (selected.id) sectionRefs.current[selected.id] = node;
                  }}
                  className="input lyric-line h-full min-h-[320px] flex-1 resize-none font-mono leading-6"
                  value={selected.content}
                  placeholder="Write freely. Nothing here is auto-rewritten."
                  onChange={(event) => updateSection(selected.id ?? "", { content: event.target.value })}
                  onSelect={(event) => {
                    const target = event.target as HTMLTextAreaElement;
                    setSelection(target.value.slice(target.selectionStart, target.selectionEnd));
                  }}
                  spellCheck
                />

                {showRhymes && (
                  <div className="hidden w-40 shrink-0 overflow-hidden rounded-lg bg-studio-950/60 p-2 font-mono text-[11px] leading-6 text-studio-400 lg:block">
                    {selected.content.split("\n").map((line, index) => {
                      const rhymeClass = rhymeByLine.map.get(String(index));
                      const endWord = line.trim().split(/\s+/).pop() ?? "";
                      const globalIndex = globalLineIndex(sections, selected, index);
                      const groupForLine = globalIndex !== null ? rhymeByLine.map.get(String(globalIndex)) : undefined;
                      return (
                        <div key={index} className="flex items-center justify-between gap-1">
                          <span className={groupForLine !== undefined ? RHYME_CLASSES[groupForLine] : ""}>
                            {endWord ? rhymeKey(endWord) || endWord : "…"}
                          </span>
                          <span className="text-studio-500">{line.trim() ? lineSyllables(line) : ""}</span>
                          {rhymeClass !== undefined && <span className="text-studio-600">r</span>}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-3 text-xs text-studio-400">
                <span>{metrics.totalLines} lines</span>
                <span>{metrics.totalWords} words</span>
                <span>{metrics.totalSyllables} syllables</span>
                <span>avg {metrics.averageSyllablesPerLine}/line</span>
                <span>{metrics.rhymeGroups.length} rhyme groups</span>
              </div>
            </>
          ) : (
            <p className="text-sm text-studio-400">Add a section to start writing.</p>
          )}
        </section>

        {/* --- AI + versions + health ------------------------------------ */}
        <div className="flex flex-col gap-4">
          <AiPanel
            songId={songId}
            sectionId={selected?.id ?? null}
            selection={selection}
            onInsert={insertFromAi}
            onError={onError}
            notify={notify}
          />

          <section className="card">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-studio-300">Song health</h2>
            <div className="flex flex-col gap-1 text-xs">
              {detail.health.checks.map((check) => (
                <div key={check.key} className="flex items-start justify-between gap-2">
                  <span className="text-studio-300">{check.label}</span>
                  <span className={check.status === "ok" ? "pill-ok" : check.status === "watch" ? "pill-watch" : "pill-weak"}>
                    {check.status}
                  </span>
                </div>
              ))}
            </div>
            <ul className="mt-2 list-disc pl-4 text-xs text-studio-400">
              {detail.health.checks.map((check) => (
                <li key={`${check.key}-note`}>{check.note}</li>
              ))}
            </ul>
            <button className="btn btn-xs mt-2" onClick={() => void load()}>
              Refresh analysis
            </button>
          </section>

          <section className="card">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-studio-300">Versions</h2>
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto text-xs">
              {versions.map((version) => (
                <div key={version.id} className="card-tight">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">
                      v{version.versionNo} · {version.name ?? "snapshot"}
                    </span>
                    <button className="btn btn-xs" onClick={() => void restore(version.id)}>
                      Restore
                    </button>
                  </div>
                  <div className="mt-1 text-studio-400">{new Date(version.createdAt).toLocaleString()}</div>
                  {version.preview && <div className="mt-1 line-clamp-2 text-studio-400">{version.preview}</div>}
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function lineSyllables(line: string): number {
  return analyseLyrics([{ kind: "x", content: line }]).totalSyllables;
}

function selectedSyllables(content: string): number {
  return analyseLyrics([{ kind: "x", content }]).totalSyllables;
}

function globalLineIndex(sections: SongSectionPayload[], selected: SongSectionPayload, localIndex: number): number | null {
  let offset = 0;
  for (const section of sections) {
    const lines = section.content.split("\n").filter((line) => line.trim().length > 0);
    if (section.id === selected.id) {
      // Skip blank lines so the index lines up with the rhyme groups.
      let seen = 0;
      const contentLines = section.content.split("\n");
      for (let index = 0; index < contentLines.length; index++) {
        if (index === localIndex) return (contentLines[index] ?? "").trim() ? offset + seen : null;
        if ((contentLines[index] ?? "").trim()) seen++;
      }
      return null;
    }
    offset += lines.length;
  }
  return null;
}
