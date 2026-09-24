import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ArtistProfile } from "../api";

const LANGUAGES = ["English", "Twi", "Ewe", "Ga", "Nigerian Pidgin", "Ghanaian Pidgin"];
const RHYME_PREFS = ["Any", "Mostly near rhyme", "Mostly perfect rhyme", "Internal rhyme", "No rhyme (spoken)"];
const SENTENCE_LENGTHS = ["Short and punchy", "Medium", "Long and flowing", "Mixed"];

/** Artist Voice System (spec §18) — what the AI should learn about this artist. */
export default function ProfileView({
  onError,
  notify,
}: {
  onError: (message: string) => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}) {
  const [profile, setProfile] = useState<ArtistProfile | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api.getProfile();
      setProfile(result.profile);
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not load your profile");
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (patch: Partial<ArtistProfile>) => {
    setBusy(true);
    try {
      const result = await api.saveProfile(patch);
      setProfile(result.profile);
      notify("Preferences saved");
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not save");
    } finally {
      setBusy(false);
    }
  };

  if (!profile) return <div className="text-sm text-studio-400">Loading artist profile…</div>;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Your voice</h1>
        <p className="text-sm text-studio-400">
          The AI uses this instead of guessing, and it learns from what you keep or reject.
        </p>
      </header>

      <section className="card grid gap-3 lg:grid-cols-2">
        <div>
          <label className="label" htmlFor="style">
            Preferred style
          </label>
          <input
            id="style"
            className="input"
            defaultValue={profile.style ?? ""}
            onBlur={(event) => void save({ style: event.target.value })}
            placeholder="melodic Afro-fusion"
          />
        </div>
        <div>
          <label className="label">Languages</label>
          <div className="flex flex-wrap gap-1">
            {LANGUAGES.map((language) => {
              const active = profile.languages.includes(language);
              return (
                <button
                  key={language}
                  className={active ? "chip-active btn-xs" : "chip btn-xs"}
                  disabled={busy}
                  onClick={() =>
                    void save({
                      languages: active ? profile.languages.filter((entry) => entry !== language) : [...profile.languages, language],
                    })
                  }
                >
                  {language}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="rhyme">
            Rhyme preference
          </label>
          <select
            id="rhyme"
            className="input"
            value={profile.rhymePreference ?? ""}
            onChange={(event) => void save({ rhymePreference: event.target.value })}
          >
            <option value="">—</option>
            {RHYME_PREFS.map((pref) => (
              <option key={pref} value={pref}>
                {pref}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="length">
            Sentence length
          </label>
          <select
            id="length"
            className="input"
            value={profile.sentenceLength ?? ""}
            onChange={(event) => void save({ sentenceLength: event.target.value })}
          >
            <option value="">—</option>
            {SENTENCE_LENGTHS.map((length) => (
              <option key={length} value={length}>
                {length}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="card grid gap-3 lg:grid-cols-2">
        <ListEditor label="Themes you return to" values={profile.themes} onSave={(values) => void save({ themes: values })} placeholder="ambition" />
        <ListEditor label="Vocabulary you actually use" values={profile.vocabulary} onSave={(values) => void save({ vocabulary: values })} placeholder="hustle" />
        <ListEditor label="Favourite imagery" values={profile.imagery} onSave={(values) => void save({ imagery: values })} placeholder="rain on glass" />
        <ListEditor label="Taboo phrases (never used)" values={profile.taboo} onSave={(values) => void save({ taboo: values })} placeholder="never use this phrase" />
      </section>

      <section className="card">
        <label className="label" htmlFor="writing-samples">
          Writing samples (paste a verse you are proud of — used for retrieval, never for training)
        </label>
        <textarea
          id="writing-samples"
          className="input h-32 resize-none font-mono text-xs"
          defaultValue={profile.writingSamples.join("\n---\n")}
          onBlur={(event) =>
            void save({
              writingSamples: event.target.value
                .split("\n---\n")
                .map((entry) => entry.trim())
                .filter(Boolean),
            })
          }
        />
      </section>
    </div>
  );
}

function ListEditor({
  label,
  values,
  onSave,
  placeholder,
}: {
  label: string;
  values: string[];
  onSave: (values: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");

  return (
    <div>
      <label className="label">{label}</label>
      <div className="mb-2 flex flex-wrap gap-1">
        {values.map((value) => (
          <button key={value} className="chip btn-xs" onClick={() => onSave(values.filter((entry) => entry !== value))}>
            {value} ✕
          </button>
        ))}
        {values.length === 0 && <span className="text-xs text-studio-400">none yet</span>}
      </div>
      <div className="flex gap-2">
        <input
          className="input"
          value={draft}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim()) {
              onSave([...values, draft.trim()]);
              setDraft("");
            }
          }}
        />
        <button
          className="btn btn-xs"
          onClick={() => {
            if (draft.trim()) {
              onSave([...values, draft.trim()]);
              setDraft("");
            }
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}
