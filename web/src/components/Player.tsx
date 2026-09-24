import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import type { BeatProfile } from "@shared/types";

export interface PlayerSection {
  id: string;
  label: string;
  start: number;
  end: number;
}

/**
 * Beat player: waveform, section markers, bar grid, section looping and
 * keyboard control (spec §21, §44).
 *
 * Bar/beat positions come from the analysed profile — the timeline is the
 * artist's rhythmic reference while writing.
 */
export default function Player({
  audioUrl,
  profile,
  sections,
  loopSectionId,
  onLoopChange,
  onTimeUpdate,
  loading,
  error,
}: {
  audioUrl: string | null;
  profile: BeatProfile | null;
  sections: PlayerSection[];
  loopSectionId: string | null;
  onLoopChange: (sectionId: string | null) => void;
  onTimeUpdate?: (time: number) => void;
  loading?: boolean;
  error?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const waveRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const loopRef = useRef<{ start: number; end: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [rate, setRate] = useState(1);
  const [metronome, setMetronome] = useState(false);

  // --- waveform lifecycle --------------------------------------------------
  useEffect(() => {
    if (!audioUrl || !containerRef.current) return;
    const regions = RegionsPlugin.create();
    const wavesurfer = WaveSurfer.create({
      container: containerRef.current,
      url: audioUrl,
      height: 68,
      waveColor: "#39415a",
      progressColor: "#7c5cff",
      cursorColor: "#ff8f5c",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      plugins: [regions],
    });
    waveRef.current = wavesurfer;
    regionsRef.current = regions;

    const subs = [
      wavesurfer.on("ready", () => setDuration(wavesurfer.getDuration())),
      wavesurfer.on("play", () => setPlaying(true)),
      wavesurfer.on("pause", () => setPlaying(false)),
      wavesurfer.on("timeupdate", (current) => {
        setTime(current);
        onTimeUpdate?.(current);
        const loop = loopRef.current;
        if (loop && current >= loop.end) wavesurfer.setTime(loop.start);
      }),
      wavesurfer.on("error", () => setPlaying(false)),
    ];

    return () => {
      for (const unsubscribe of subs) unsubscribe();
      wavesurfer.destroy();
      waveRef.current = null;
      regionsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioUrl]);

  // --- section markers -----------------------------------------------------
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions) return;
    regions.clearRegions();
    const colors = ["#7c5cff33", "#4fd1a533", "#ff8f5c33", "#f472b633", "#60a5fa33"];
    sections.forEach((section, index) => {
      if (!Number.isFinite(section.start) || section.end <= section.start) return;
      regions.addRegion({
        id: section.id,
        start: section.start,
        end: section.end,
        content: section.label,
        color: colors[index % colors.length],
        drag: false,
        resize: false,
      });
    });
  }, [sections, audioUrl]);

  // --- looping -------------------------------------------------------------
  useEffect(() => {
    const active = sections.find((section) => section.id === loopSectionId) ?? null;
    loopRef.current = active ? { start: active.start, end: active.end } : null;
    if (active && waveRef.current) {
      const current = waveRef.current.getCurrentTime();
      if (current < active.start || current > active.end) waveRef.current.setTime(active.start);
    }
  }, [loopSectionId, sections]);

  // --- keyboard shortcuts (spec §44) --------------------------------------
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      if (event.code === "Space") {
        event.preventDefault();
        waveRef.current?.playPause();
      } else if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        onLoopChange(loopSectionId ? null : (sections[0]?.id ?? null));
      } else if (event.key.toLowerCase() === "m") {
        setMetronome((value) => !value);
      } else if (event.key === "ArrowLeft") {
        waveRef.current?.skip(-5);
      } else if (event.key === "ArrowRight") {
        waveRef.current?.skip(5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loopSectionId, onLoopChange, sections]);

  // --- metronome (needs the grid) -----------------------------------------
  useEffect(() => {
    if (!metronome || !profile || profile.rhythm.beat_grid.length === 0) return;
    const beats = profile.rhythm.beat_grid;
    const downbeats = new Set(profile.rhythm.downbeats.map((value) => Math.round(value * 1000)));
    let cancelled = false;
    let audioContext: AudioContext | null = null;

    const schedule = () => {
      if (cancelled) return;
      const current = waveRef.current?.getCurrentTime() ?? 0;
      const next = beats.find((beat) => beat >= current && beat < current + 0.25);
      if (next !== undefined && playing) {
        audioContext = audioContext ?? new AudioContext();
        const isDownbeat = downbeats.has(Math.round(next * 1000));
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.frequency.value = isDownbeat ? 1600 : 1000;
        gain.gain.value = 0.05;
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start();
        oscillator.stop(audioContext.currentTime + 0.03);
      }
      window.setTimeout(schedule, 60);
    };
    schedule();
    return () => {
      cancelled = true;
      void audioContext?.close();
    };
  }, [metronome, profile, playing]);

  const gridTicks = (() => {
    if (!profile || duration <= 0) return [];
    const bars = profile.rhythm.downbeats.slice(0, 400);
    return bars.map((bar) => (bar / duration) * 100).filter((percent) => percent >= 0 && percent <= 100);
  })();

  return (
    <div className="card flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary btn-xs" onClick={() => waveRef.current?.playPause()} disabled={!audioUrl}>
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button className="btn btn-xs" onClick={() => waveRef.current?.setTime(0)} disabled={!audioUrl}>
          ⏮ Start
        </button>
        <span className="font-mono text-xs text-studio-300">
          {formatTime(time)} / {formatTime(duration)}
        </span>

        <label className="ml-2 flex items-center gap-1 text-xs text-studio-300">
          Speed
          <input
            type="range"
            min={0.5}
            max={1.5}
            step={0.05}
            value={rate}
            onChange={(event) => {
              const value = Number(event.target.value);
              setRate(value);
              waveRef.current?.setPlaybackRate(value);
            }}
            className="w-24 accent-[#7c5cff]"
          />
          <span className="font-mono">{rate.toFixed(2)}×</span>
        </label>

        <label className="flex items-center gap-1 text-xs text-studio-300">
          <input type="checkbox" checked={Boolean(loopSectionId)} onChange={(event) => onLoopChange(event.target.checked ? (sections[0]?.id ?? null) : null)} />
          Loop section (L)
        </label>

        <label className="flex items-center gap-1 text-xs text-studio-300">
          <input type="checkbox" checked={metronome} onChange={(event) => setMetronome(event.target.checked)} />
          Metronome (M)
        </label>

        {profile && (
          <span className="chip ml-auto">
            {profile.bpm} BPM · {profile.key} · {profile.time_signature}
          </span>
        )}
      </div>

      <div className="relative">
        <div ref={containerRef} className="w-full overflow-hidden rounded-lg bg-studio-950/60" />
        {gridTicks.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[68px]">
            {gridTicks.map((percent, index) => (
              <span
                key={index}
                className="absolute top-0 h-full border-l border-studio-400/15"
                style={{ left: `${percent}%` }}
              />
            ))}
          </div>
        )}
        {!audioUrl && !loading && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-studio-400">
            {error ?? "Audio is not available yet"}
          </div>
        )}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-studio-400">Loading audio…</div>
        )}
      </div>

      {sections.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {sections.map((section) => (
            <button
              key={section.id}
              className={`btn btn-xs ${loopSectionId === section.id ? "border-accent text-accent-soft" : ""}`}
              onClick={() => {
                onLoopChange(loopSectionId === section.id ? null : section.id);
                waveRef.current?.setTime(section.start);
              }}
              title={`${formatTime(section.start)} – ${formatTime(section.end)}`}
            >
              {section.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
