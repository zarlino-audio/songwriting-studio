import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type BeatSummary } from "../api";

const ACCEPTED = ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/flac", "audio/x-flac", "audio/aac", "audio/ogg", ".wav", ".mp3", ".m4a", ".flac", ".aac"];

export default function BeatsView({
  onNavigate,
  onError,
  notify,
}: {
  onNavigate: (path: string) => void;
  onError: (message: string) => void;
  notify: (message: string, kind?: "info" | "success" | "error") => void;
}) {
  const [beats, setBeats] = useState<BeatSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.listBeats();
      setBeats(result.beats);
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Could not load beats");
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setProgress(0);
      try {
        const beatId = await api.uploadBeat(file, undefined, setProgress);
        notify(`“${file.name}” uploaded — analysing the beat`);
        onNavigate(`/beats/${beatId}`);
      } catch (error) {
        onError(error instanceof ApiError ? `${error.message}${error.detail ? ` — ${error.detail}` : ""}` : "Upload failed");
      } finally {
        setUploading(false);
        setProgress(0);
      }
    },
    [notify, onError, onNavigate],
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">My beats</h1>
          <p className="text-sm text-studio-400">WAV, MP3, M4A, FLAC or AAC. Uploads go straight to private storage.</p>
        </div>
      </header>

      <section
        className={`card flex flex-col items-center justify-center gap-2 border-dashed py-8 text-center transition ${
          dragging ? "border-accent bg-accent/10" : ""
        }`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) void upload(file);
        }}
      >
        <p className="text-sm text-studio-200">Drop a beat here</p>
        <p className="text-xs text-studio-400">or</p>
        <button className="btn" onClick={() => inputRef.current?.click()} disabled={uploading}>
          Choose a file
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED.join(",")}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
            event.target.value = "";
          }}
        />
        {uploading && (
          <div className="mt-3 w-full max-w-sm">
            <div className="h-2 overflow-hidden rounded-full bg-studio-800">
              <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="mt-1 text-xs text-studio-400">{Math.round(progress * 100)}% uploaded</p>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        {beats.map((beat) => (
          <div key={beat.id} className="card flex items-center justify-between gap-3">
            <button className="min-w-0 text-left" onClick={() => onNavigate(`/beats/${beat.id}`)}>
              <div className="truncate text-sm font-medium">{beat.title}</div>
              <div className="text-xs text-studio-400">
                {beat.originalFilename ?? "audio"} · {beat.durationSeconds ? `${Math.round(beat.durationSeconds)}s` : "duration pending"}
              </div>
            </button>
            <div className="flex items-center gap-2">
              <span className={beat.status === "READY" ? "pill-ok" : beat.status === "FAILED" ? "pill-weak" : "pill-watch"}>{beat.status}</span>
              <button className="btn btn-xs" onClick={() => onNavigate(`/beats/${beat.id}`)}>
                Open
              </button>
            </div>
          </div>
        ))}
        {beats.length === 0 && <p className="text-sm text-studio-400">No beats yet.</p>}
      </section>
    </div>
  );
}
