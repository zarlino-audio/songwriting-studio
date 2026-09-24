import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type BeatDetail } from "../api";

export default function BeatDetailView({
  beatId,
  onNavigate,
  onError,
  notify,
}: {
  beatId: string;
  onNavigate: (path: string) => void;
  onError: (message: string) => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}) {
  const [detail, setDetail] = useState<BeatDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [editBpm, setEditBpm] = useState("");
  const [editKey, setEditKey] = useState("");
  const [songTitle, setSongTitle] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api.getBeat(beatId);
      setDetail(result);
      setEditBpm(String(result.profile?.bpm ?? ""));
      setEditKey(result.profile?.key ?? "");
      setSongTitle(`${result.beat.title} — new song`);
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not load the beat");
    }
  }, [beatId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while the analysis pipeline is working.
  useEffect(() => {
    if (!detail || (detail.beat.status !== "ANALYZING" && detail.beat.status !== "UPLOADING")) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [detail, load]);

  const saveCorrections = async () => {
    if (!detail?.profile) return;
    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      const bpm = Number(editBpm);
      if (Number.isFinite(bpm) && bpm > 0) patch["bpm"] = bpm;
      if (editKey.trim()) patch["key"] = editKey.trim();
      await api.correctBeatProfile(beatId, patch);
      notify("Profile corrected");
      await load();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not save the correction");
    } finally {
      setBusy(false);
    }
  };

  const createSong = async () => {
    setBusy(true);
    try {
      const result = await api.createSong({ beatId, title: songTitle.trim() || undefined });
      notify("Song created — start writing");
      onNavigate(`/songs/${result.song.id}`);
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not create the song");
    } finally {
      setBusy(false);
    }
  };

  const reanalyze = async () => {
    try {
      await api.reanalyzeBeat(beatId);
      notify("Re-analysing the beat");
      await load();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not start the analysis");
    }
  };

  if (!detail) return <div className="text-sm text-studio-400">Loading beat…</div>;

  const { beat, profile, intelligence, job } = detail;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <button className="btn-ghost btn-xs mb-1" onClick={() => onNavigate("/beats")}>
            ← My beats
          </button>
          <h1 className="text-xl font-semibold tracking-tight">{beat.title}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-studio-400">
            <span className={beat.status === "READY" ? "pill-ok" : beat.status === "FAILED" ? "pill-weak" : "pill-watch"}>
              {beat.status}
            </span>
            {beat.durationSeconds && <span>{Math.round(beat.durationSeconds)}s</span>}
            {detail.analysisEngine && <span>engine: {detail.analysisEngine}</span>}
            {detail.analysisSource === "corrected" && <span>· corrected by you</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input className="input w-56" value={songTitle} onChange={(event) => setSongTitle(event.target.value)} placeholder="New song title" />
          <button className="btn-primary btn-xs" onClick={() => void createSong()} disabled={busy || beat.status !== "READY"}>
            Start a song with this beat
          </button>
        </div>
      </header>

      {beat.status === "FAILED" && (
        <div className="card border-rose-500/40 text-sm text-rose-200">
          Analysis failed: {beat.error ?? job?.error ?? "unknown error"}
          <button className="btn btn-xs ml-3" onClick={() => void reanalyze()}>
            Try again
          </button>
        </div>
      )}

      {(beat.status === "ANALYZING" || beat.status === "UPLOADING") && (
        <div className="card text-sm text-studio-300">
          Analysing the beat — this runs in the background. The profile appears here automatically.
        </div>
      )}

      {intelligence && (
        <section className="card">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-studio-300">What this beat is giving</h2>
          <p className="mt-2 text-lg font-medium">{intelligence.headline}</p>
          <p className="mt-1 text-sm text-studio-200">{intelligence.summary}</p>

          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-studio-400">Songwriting characteristics</h3>
              <ul className="list-disc pl-5 text-sm text-studio-200">
                {intelligence.characteristics.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-studio-400">Musical evidence</h3>
              <ul className="list-disc pl-5 text-xs text-studio-300">
                {intelligence.evidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}

      {profile && (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-studio-300">Beat profile</h2>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Field label="BPM" value={String(profile.bpm)} />
              <Field label="Key" value={profile.key} />
              <Field label="Time signature" value={profile.time_signature} />
              <Field label="Duration" value={`${Math.round(profile.duration_seconds)}s`} />
              <Field label="Bars" value={String(profile.rhythm.bar_count)} />
              <Field label="Density" value={profile.rhythm.density.toFixed(2)} />
              <Field label="Syncopation" value={profile.rhythm.syncopation.toFixed(2)} />
              <Field label="Groove" value={profile.rhythm.groove} />
              <Field label="LUFS" value={profile.technical.lufs.toFixed(1)} />
              <Field label="Peak dB" value={profile.technical.peak_db.toFixed(1)} />
              <Field label="Dynamic range" value={`${profile.technical.dynamic_range_db.toFixed(1)} dB`} />
              <Field label="Mood" value={profile.mood.join(", ")} />
            </div>

            <div className="mt-4">
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-studio-400">Energy curve (per bar)</h3>
              <div className="flex h-16 items-end gap-[1px]">
                {profile.energy.curve.slice(0, 400).map((value, index) => (
                  <span
                    key={index}
                    className="flex-1 rounded-t bg-accent/70"
                    style={{ height: `${Math.max(4, value * 100)}%` }}
                    title={value.toFixed(2)}
                  />
                ))}
              </div>
            </div>
          </section>

          <section className="card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-studio-300">Detected structure</h2>
            <div className="flex flex-col gap-1">
              {profile.sections.map((section, index) => (
                <div key={`${section.type}-${index}`} className="flex items-center justify-between rounded-lg bg-studio-850/70 px-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <span className="section-kind">{section.type}</span>
                    <span className="text-studio-300">
                      {formatSeconds(section.start)} – {formatSeconds(section.end)}
                    </span>
                  </span>
                  <span className="text-xs text-studio-400">
                    bars {section.bars[0]}–{section.bars[1]} · energy {section.energy.toFixed(2)} · conf {section.confidence.toFixed(2)}
                  </span>
                </div>
              ))}
              {profile.sections.length === 0 && <p className="text-sm text-studio-400">No sections detected.</p>}
            </div>

            {profile.harmony.progression.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-studio-400">Chord progression</h3>
                <p className="font-mono text-sm text-studio-200">{profile.harmony.progression.slice(0, 24).join("  →  ")}</p>
              </div>
            )}

            {profile.warnings.length > 0 && (
              <div className="mt-4">
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-studio-400">Signals to double-check</h3>
                <ul className="list-disc pl-5 text-xs text-amber-300">
                  {profile.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </div>
      )}

      {profile && (
        <section className="card">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-studio-300">Correct the analysis</h2>
          <p className="mb-3 text-xs text-studio-400">
            These are estimates. Fix anything that is wrong — every suggestion the AI makes is built on this.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="bpm">
                BPM
              </label>
              <input id="bpm" className="input w-24" value={editBpm} onChange={(event) => setEditBpm(event.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="key">
                Key
              </label>
              <input id="key" className="input w-40" value={editKey} onChange={(event) => setEditKey(event.target.value)} />
            </div>
            <button className="btn" onClick={() => void saveCorrections()} disabled={busy}>
              Save correction
            </button>
            <button className="btn-ghost" onClick={() => void reanalyze()}>
              Re-analyse from scratch
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className="font-mono text-sm text-studio-100">{value}</div>
    </div>
  );
}

function formatSeconds(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
