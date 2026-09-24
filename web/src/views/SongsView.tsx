import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type BeatSummary, type SongSummary } from "../api";

const INTENTIONS = ["love", "heartbreak", "ambition", "street life", "money", "nostalgia", "confidence", "spiritual", "celebration", "storytelling", "vulnerability"];
const LANGUAGES = ["English", "Twi", "Ewe", "Ga", "Nigerian Pidgin", "Ghanaian Pidgin", "Mixed"];
const PERSPECTIVES = ["First person", "Third person", "Character", "Personal experience", "Fictional story"];
const ENERGIES = ["Low", "Reflective", "Medium", "Confident", "Aggressive", "Explosive"];

export default function SongsView({
  onNavigate,
  onError,
  notify,
}: {
  onNavigate: (path: string) => void;
  onError: (message: string) => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}) {
  const [songs, setSongs] = useState<SongSummary[]>([]);
  const [beats, setBeats] = useState<BeatSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    title: "",
    beatId: "",
    concept: "",
    intention: "",
    language: "",
    perspective: "",
    energy: "",
  });

  const load = useCallback(async () => {
    try {
      const [songsResult, beatsResult] = await Promise.all([api.listSongs(), api.listBeats()]);
      setSongs(songsResult.songs);
      setBeats(beatsResult.beats.filter((beat) => beat.status === "READY"));
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not load your songs");
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    try {
      const result = await api.createSong({
        title: form.title.trim() || undefined,
        beatId: form.beatId || undefined,
        concept: form.concept.trim() || undefined,
        intention: form.intention || undefined,
        language: form.language || undefined,
        perspective: form.perspective || undefined,
        energy: form.energy || undefined,
      });
      notify("Song created");
      onNavigate(`/songs/${result.song.id}`);
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not create the song");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Songs</h1>
          <p className="text-sm text-studio-400">Every field here is optional — you can start writing immediately.</p>
        </div>
        <button className="btn" onClick={() => setCreating((value) => !value)}>
          {creating ? "Close" : "New song"}
        </button>
      </header>

      {creating && (
        <section className="card grid gap-3 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <label className="label" htmlFor="song-title">
              Working title
            </label>
            <input id="song-title" className="input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="Untitled song" />
          </div>
          <div>
            <label className="label" htmlFor="song-beat">
              Beat
            </label>
            <select id="song-beat" className="input" value={form.beatId} onChange={(event) => setForm({ ...form, beatId: event.target.value })}>
              <option value="">No beat yet</option>
              {beats.map((beat) => (
                <option key={beat.id} value={beat.id}>
                  {beat.title}
                </option>
              ))}
            </select>
          </div>
          <div className="lg:col-span-3">
            <label className="label" htmlFor="song-concept">
              What are you trying to say? (optional)
            </label>
            <input
              id="song-concept"
              className="input"
              value={form.concept}
              onChange={(event) => setForm({ ...form, concept: event.target.value })}
              placeholder="e.g. success changed the environment, not the hunger"
            />
          </div>
          <Select label="Intention" value={form.intention} options={INTENTIONS} onChange={(value) => setForm({ ...form, intention: value })} />
          <Select label="Language" value={form.language} options={LANGUAGES} onChange={(value) => setForm({ ...form, language: value })} />
          <Select label="Perspective" value={form.perspective} options={PERSPECTIVES} onChange={(value) => setForm({ ...form, perspective: value })} />
          <Select label="Energy" value={form.energy} options={ENERGIES} onChange={(value) => setForm({ ...form, energy: value })} />
          <div className="flex items-end lg:col-span-2">
            <button className="btn-primary w-full" onClick={() => void create()}>
              Create song
            </button>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        {songs.map((song) => (
          <div key={song.id} className="card flex items-center justify-between gap-3">
            <button className="min-w-0 text-left" onClick={() => onNavigate(`/songs/${song.id}`)}>
              <div className="truncate text-sm font-medium">{song.title}</div>
              <div className="truncate text-xs text-studio-400">
                {song.beatTitle ?? "no beat"} · v{song.currentVersion} · updated {new Date(song.updatedAt).toLocaleString()}
              </div>
            </button>
            <div className="flex items-center gap-2">
              <span className={song.status === "complete" ? "pill-ok" : "pill-watch"}>{song.status}</span>
              <button className="btn btn-xs" onClick={() => onNavigate(`/songs/${song.id}`)}>
                Open
              </button>
            </div>
          </div>
        ))}
        {songs.length === 0 && <p className="text-sm text-studio-400">No songs yet.</p>}
      </section>
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <select className="input" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">—</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}
