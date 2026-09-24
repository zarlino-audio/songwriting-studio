import { useEffect, useState } from "react";
import { api, ApiError, type BeatSummary, type HealthReport, type SongSummary } from "../api";

export default function DashboardView({
  onNavigate,
  onError,
}: {
  onNavigate: (path: string) => void;
  onError: (message: string) => void;
}) {
  const [beats, setBeats] = useState<BeatSummary[]>([]);
  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [stats, setStats] = useState<{ songsCompleted: number; songsStarted: number; suggestionsAccepted: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [beatsResult, songsResult] = await Promise.all([api.listBeats(), api.listSongs()]);
        setBeats(beatsResult.beats);
        setSongs(songsResult.songs);
      } catch (error) {
        onError(error instanceof ApiError ? error.message : "Could not load your library");
      }
      try {
        setHealth(await api.health());
      } catch {
        setHealth(null);
      }
      try {
        setStats(await api.observability());
      } catch {
        setStats(null);
      }
    })();
  }, [onError]);

  const readyBeats = beats.filter((beat) => beat.status === "READY").length;
  const drafts = songs.filter((song) => song.status !== "complete").length;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-studio-400">Upload a beat, then write with it.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn-primary" onClick={() => onNavigate("/beats")}>
            Upload a beat
          </button>
          <button className="btn" onClick={() => onNavigate("/songs")}>
            Start a song
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="card">
          <div className="stat">{beats.length}</div>
          <div className="stat-label">Beats · {readyBeats} analysed</div>
        </div>
        <div className="card">
          <div className="stat">{drafts}</div>
          <div className="stat-label">Songs in progress</div>
        </div>
        <div className="card">
          <div className="stat">{stats?.songsCompleted ?? 0}</div>
          <div className="stat-label">Songs finished</div>
        </div>
        <div className="card">
          <div className="stat">{stats?.suggestionsAccepted ?? 0}</div>
          <div className="stat-label">Suggestions kept</div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-studio-300">Recent beats</h2>
            <button className="btn-ghost btn-xs" onClick={() => onNavigate("/beats")}>
              All beats →
            </button>
          </div>
          {beats.length === 0 ? (
            <p className="text-sm text-studio-400">No beats yet. Upload one to begin.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {beats.slice(0, 5).map((beat) => (
                <li key={beat.id}>
                  <button className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-studio-800" onClick={() => onNavigate(`/beats/${beat.id}`)}>
                    <span className="truncate text-sm">{beat.title}</span>
                    <span className={beat.status === "READY" ? "pill-ok" : beat.status === "FAILED" ? "pill-weak" : "pill-watch"}>{beat.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-studio-300">Recent songs</h2>
            <button className="btn-ghost btn-xs" onClick={() => onNavigate("/songs")}>
              All songs →
            </button>
          </div>
          {songs.length === 0 ? (
            <p className="text-sm text-studio-400">No songs yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {songs.slice(0, 5).map((song) => (
                <li key={song.id}>
                  <button className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-studio-800" onClick={() => onNavigate(`/songs/${song.id}`)}>
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{song.title}</span>
                      <span className="block truncate text-xs text-studio-400">{song.beatTitle ?? "no beat"} · v{song.currentVersion}</span>
                    </span>
                    <span className={song.status === "complete" ? "pill-ok" : "pill-watch"}>{song.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {health && (
        <section className="card">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-studio-300">Studio health</h2>
          <div className="flex flex-wrap gap-2">
            {Object.entries(health.checks).map(([name, value]) => (
              <span key={name} className={value ? "pill-ok" : "pill-weak"}>
                {name}
              </span>
            ))}
            <span className="chip">analysis: {health.analysis.mode}</span>
            <span className="chip">ai: {health.ai.provider}</span>
          </div>
          {health.hints.length > 0 && (
            <ul className="mt-3 list-disc pl-5 text-xs text-studio-400">
              {health.hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
