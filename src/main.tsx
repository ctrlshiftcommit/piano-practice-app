import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  Headphones,
  Library,
  Mic,
  Music2,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Sun,
  Moon,
  Upload,
  X,
} from "lucide-react";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/newsreader/400.css";
import "./style.css";
import { PianoListener } from "./audio";
import type { PitchListenerStatus } from "./pitch";
import { demos, parseMusicXML, renderScore, type Score } from "./score";
type PracticeMode = "play-through" | "learn";
type Prefs = {
  practiceMode: PracticeMode;
  light: boolean;
  labels: boolean;
  octaves: boolean;
  follow: boolean;
  tempoAdvice: boolean;
  tolerance: number;
  opacity: number;
  good: string;
  bad: string;
  microphoneId: string;
  referenceA4: number;
};
const defaults: Prefs = {
  practiceMode: "play-through",
  light: false,
  labels: true,
  octaves: false,
  follow: true,
  tempoAdvice: true,
  tolerance: 15,
  opacity: 0.32,
  good: "#61cf9b",
  bad: "#ef7777",
  microphoneId: "",
  referenceA4: 440,
};
function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function App() {
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const stored = read<Partial<Prefs>>("still-prefs", {});
    return {
      ...defaults,
      ...stored,
      practiceMode: stored.practiceMode === "learn" ? "learn" : "play-through",
      microphoneId: typeof stored.microphoneId === "string" ? stored.microphoneId : "",
      referenceA4: typeof stored.referenceA4 === "number" && Number.isFinite(stored.referenceA4) && stored.referenceA4 >= 400 && stored.referenceA4 <= 480
        ? stored.referenceA4 : 440,
    };
  });
  const [saved, setSaved] = useState<Score[]>(() => read("still-scores", []));
  const [score, setScore] = useState<Score>(demos[0]);
  const [panel, setPanel] = useState<"library" | "settings" | null>(null);
  const [active, setActive] = useState(0);
  const [marks, setMarks] = useState<Record<number, string>>({});
  const [running, setRunning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [input, setInput] = useState<"microphone" | "keyboard">("microphone");
  const [bpm, setBpm] = useState(80);
  const [bpmDraft, setBpmDraft] = useState("80");
  const [measured, setMeasured] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [heard, setHeard] = useState("—");
  const [detectionState, setDetectionState] = useState<PitchListenerStatus["state"]>("quiet");
  const [pitchStatus, setPitchStatus] = useState<PitchListenerStatus>({ state: "quiet" });
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphoneError, setMicrophoneError] = useState("");
  const [referenceDraft, setReferenceDraft] = useState(String(prefs.referenceA4));
  const [followPaused, setFollowPaused] = useState(false);
  const listener = useRef(new PianoListener());
  const paper = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const last = useRef<{ time: number; beats: number } | null>(null);
  const intervals = useRef<number[]>([]);
  const generation = useRef(0);
  const live = useRef({ active, score, running, bpm, prefs });
  live.current = { active, score, running, bpm, prefs };
  useEffect(() => {
    localStorage.setItem("still-prefs", JSON.stringify(prefs));
    document.documentElement.dataset.theme = prefs.light ? "light" : "dark";
  }, [prefs]);
  useEffect(() => () => listener.current.stop(), []);
  useEffect(() => setReferenceDraft(String(prefs.referenceA4)), [prefs.referenceA4]);
  async function refreshMicrophones() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setMicrophones(devices.filter((device) => device.kind === "audioinput" && device.deviceId !== "default"));
      setMicrophoneError("");
    } catch {
      setMicrophoneError("Could not list microphone inputs.");
    }
  }
  useEffect(() => {
    if (panel !== "settings") return;
    void refreshMicrophones();
    const devices = navigator.mediaDevices;
    const changed = () => void refreshMicrophones();
    devices?.addEventListener("devicechange", changed);
    return () => devices?.removeEventListener("devicechange", changed);
  }, [panel]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  function stop() {
    generation.current++;
    listener.current.stop();
    live.current.running = false;
    setRunning(false);
    setConnecting(false);
    setDetectionState("quiet");
    setPitchStatus({ state: "quiet" });
    last.current = null;
    intervals.current = [];
  }
  function reset() {
    stop();
    setActive(0);
    setMarks({});
    setMeasured(null);
    setHeard("—");
    setError("");
    setMessage("");
    setFollowPaused(false);
  }
  function commitBpm(raw: string) {
    const parsed = raw.trim() ? Number(raw) : bpm;
    const next = Number.isFinite(parsed)
      ? Math.max(30, Math.min(240, parsed))
      : bpm;
    setBpm(next);
    setBpmDraft(String(next));
    if (next !== bpm) {
      last.current = null;
      intervals.current = [];
      setMeasured(null);
    }
  }
  function choose(s: Score) {
    reset();
    setScore(s);
    setPanel(null);
  }
  function commitReference(raw: string) {
    const parsed = raw.trim() ? Number(raw) : prefs.referenceA4;
    const next = Number.isFinite(parsed) ? Math.max(400, Math.min(480, parsed)) : prefs.referenceA4;
    setReferenceDraft(String(next));
    if (next !== prefs.referenceA4) {
      stop();
      setPrefs((previous) => ({ ...previous, referenceA4: next }));
    }
  }
  function changePracticeMode(practiceMode: PracticeMode) {
    const next = { ...live.current.prefs, practiceMode };
    live.current.prefs = next;
    setPrefs(next);
    // Changing how attacks count starts a new tempo sample without changing
    // the current position or the notes already marked.
    last.current = null;
    intervals.current = [];
    setMeasured(null);
    setMessage("");
  }
  function accept(midi: number) {
    const s = live.current;
    if (!s.running || s.active >= s.score.notes.length) return;
    // State updaters can run after live.current advances. Capture the played
    // position now so feedback never lands on the next note.
    const playedIndex = s.active;
    const note = s.score.notes[playedIndex];
    const detectedName =
      ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][
        midi % 12
      ] +
        (Math.floor(midi / 12) - 1);
    setHeard(detectedName);
    const correct = midi === note.midi;
    if (!correct && s.prefs.practiceMode === "learn") {
      setMarks((m) => ({ ...m, [playedIndex]: "incorrect" }));
      setMessage(`Heard ${detectedName} · Expected ${note.name}`);
      return;
    }
    let feedback = correct
      ? ""
      : `Heard ${detectedName} · Expected ${note.name}`;
    const now = performance.now();
    if (last.current) {
      const estimate = (60000 * last.current.beats) / (now - last.current.time);
      if (estimate > 20 && estimate < 260) {
        intervals.current = [...intervals.current.slice(-4), estimate];
        if (intervals.current.length >= 3) {
          const sorted = [...intervals.current].sort((a, b) => a - b);
          const value = Math.round(sorted[Math.floor(sorted.length / 2)]);
          setMeasured(value);
          if (correct) {
            feedback = s.prefs.tempoAdvice
              ? value > s.bpm * (1 + s.prefs.tolerance / 100)
                ? "Too fast · Slow down"
                : value < s.bpm * (1 - s.prefs.tolerance / 100)
                  ? "Too slow"
                  : "On tempo"
              : "";
          }
        }
      } else {
        intervals.current = [];
        setMeasured(null);
      }
    }
    last.current = { time: now, beats: note.beats };
    setMarks((m) => ({ ...m, [playedIndex]: correct ? "correct" : "incorrect" }));
    setMessage(feedback);
    const next = playedIndex + 1;
    live.current.active = next;
    setActive(next);
    if (next === s.score.notes.length) {
      stop();
      setMessage("Complete");
    }
  }
  async function start() {
    if (running) {
      stop();
      return;
    }
    if (active >= score.notes.length) {
      setActive(0);
      live.current.active = 0;
      setMarks({});
    }
    setError("");
    setMeasured(null);
    setMessage("");
    const token = ++generation.current;
    if (input === "keyboard") {
      live.current.running = true;
      setRunning(true);
      return;
    }
    setConnecting(true);
    try {
      await listener.current.start(accept, undefined, (status) => {
        if (token === generation.current) {
          setDetectionState(status.state);
          setPitchStatus(status);
        }
      }, { deviceId: prefs.microphoneId || undefined, referenceA4: prefs.referenceA4 });
      if (token !== generation.current) return;
      live.current.running = true;
      setRunning(true);
      void refreshMicrophones();
    } catch (e) {
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow microphone access in your browser’s site settings, then try again, or switch to Keyboard demo."
          : e instanceof Error
          ? e.message
          : "Microphone unavailable. Check browser permissions.",
      );
    } finally {
      if (token === generation.current) setConnecting(false);
    }
  }
  const [width, setWidth] = useState(window.innerWidth);
  useEffect(() => {
    const resize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const scoreMarkup = renderScore(
    score,
    prefs.labels,
    prefs.octaves,
    Math.min(900, width - 44),
  );
  // Keep React from replacing the SVG on listening-status/tempo updates.
  // Note classes are applied below; rebuilding identical markup erases them.
  const scoreHtml = useMemo(() => ({ __html: scoreMarkup }), [scoreMarkup]);
  useEffect(() => {
    paper.current
      ?.querySelectorAll<SVGGElement>("[data-note]")
      .forEach((el) => {
        const i = Number(el.dataset.note);
        el.classList.toggle("active", i === active);
        el.classList.toggle("correct", marks[i] === "correct");
        el.classList.toggle("incorrect", marks[i] === "incorrect");
      });
    if (prefs.follow && !followPaused && running) {
      const el = paper.current?.querySelector(`[data-note="${active}"]`);
      const rect = el?.getBoundingClientRect();
      if (rect && (rect.top < 130 || rect.bottom > window.innerHeight - 230))
        el?.closest(".score-system")?.scrollIntoView({
          block: "center",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "instant"
            : "smooth",
        });
    }
  }, [active, marks, prefs.follow, followPaused, running, scoreMarkup]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches("input,select,button,textarea"))
        return;
      const keys = "asdfghjkl";
      if (input === "keyboard" && !e.repeat && keys.includes(e.key)) {
        e.preventDefault();
        accept([60, 62, 64, 65, 67, 69, 71, 72, 74][keys.indexOf(e.key)]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [input]);
  async function importFile(f: File) {
    stop();
    setError("");
    if (f.name.toLowerCase().endsWith(".pdf")) {
      setError(
        "PDF recognition is not connected yet. Export a single-melody MusicXML (.xml or .musicxml) from your notation app to practise here.",
      );
      return;
    }
    try {
      if (f.size > 2_000_000)
        throw Error("Choose a MusicXML file smaller than 2 MB.");
      const s = parseMusicXML(await f.text());
      const next = [s, ...saved.filter((x) => x.id !== s.id)];
      localStorage.setItem("still-scores", JSON.stringify(next));
      setSaved(next);
      choose(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read this score.");
    }
  }
  const update = <K extends keyof Prefs>(k: K, v: Prefs[K]) =>
    setPrefs((p) => ({ ...p, [k]: v }));
  return (
    <div
      className="app"
      style={
        {
          "--good": prefs.good,
          "--bad": prefs.bad,
          "--overlay-opacity": prefs.opacity,
        } as React.CSSProperties
      }
    >
      <header>
        <button
          className="brand"
          onClick={() => {
            stop();
            setPanel("library");
          }}
          aria-label="Still library"
        >
          <span className="brand-symbol">
            <i />
            <i />
            <i />
          </span>
          still
        </button>
        <nav>
          <button
            onClick={() => {
              stop();
              setPanel(panel === "library" ? null : "library");
            }}
          >
            <Library size={17} />
            <span>My music</span>
          </button>
          <span className="divider" />
          <button
            className="icon"
            aria-label={prefs.light ? "Use dark theme" : "Use light theme"}
            onClick={() => update("light", !prefs.light)}
          >
            {prefs.light ? <Moon size={18} /> : <Sun size={18} />}
          </button>
          <button
            className={"icon " + (panel === "settings" ? "selected" : "")}
            aria-label="Settings"
            onClick={() => setPanel(panel === "settings" ? null : "settings")}
          >
            <Settings2 size={18} />
          </button>
        </nav>
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
          <button aria-label="Dismiss error" onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}
      <main>
        <div className="piece-heading">
          <div>
            <button
              className="back"
              onClick={() => {
                stop();
                setPanel("library");
              }}
            >
              <ArrowLeft size={14} /> Library
            </button>
            <h1>{score.title}</h1>
            {score.composer !== "Original exercise" && score.composer !== "Unknown composer" && <p>{score.composer}</p>}
          </div>
          <button
            className={"label-toggle " + (prefs.labels ? "on" : "")}
            onClick={() => update("labels", !prefs.labels)}
            aria-pressed={prefs.labels}
          >
            <span>Aa</span> Note names{" "}
            <span className="switch">
              <i />
            </span>
          </button>
        </div>
        <div className="score-meta">
          <span>
            <Music2 size={15} />
            <select
              aria-label="Practice mode"
              aria-describedby="practice-mode-description"
              value={prefs.practiceMode}
              onChange={(e) => changePracticeMode(e.target.value as PracticeMode)}
            >
              <option value="play-through">Play through</option>
              <option value="learn">Learn</option>
            </select>
            <span id="practice-mode-description" hidden>
              {prefs.practiceMode === "play-through"
                ? "Keeps going after mistakes"
                : "Waits for the correct note"}
            </span>
          </span>
          <span>
            {active >= score.notes.length
              ? "Complete"
              : `Measure ${score.notes[active]?.measure || 1}`}
            <span className="meta-muted"> / {score.notes.at(-1)?.measure}</span>
          </span>
        </div>
        <div
          className="paper"
          ref={paper}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              (e.target as Element).dispatchEvent(
                new MouseEvent("click", { bubbles: true }),
              );
            }
          }}
          onWheel={() => running && setFollowPaused(true)}
          onTouchMove={() => running && setFollowPaused(true)}
          onClick={(e) => {
            const g = (e.target as Element).closest(
              "[data-note]",
            ) as SVGElement | null;
            if (g) {
              const index = Number(g.dataset.note);
              setActive(index);
              live.current.active = index;
              last.current = null;
              intervals.current = [];
              setMeasured(null);
              setMarks((m) =>
                Object.fromEntries(
                  Object.entries(m).filter(([k]) => Number(k) < index),
                ),
              );
              setMessage("Continue from here.");
            }
          }}
          dangerouslySetInnerHTML={scoreHtml}
        />
      </main>
      <footer className="transport">
        <div className="progress-track">
          <div
            style={{ transform: `scaleX(${active / score.notes.length})` }}
          />
        </div>
        <div className="transport-inner">
          <div className="listening">
            <span className={"status-dot " + (running ? "live" : "")} />
            <div>
              <strong>
                {connecting
                  ? "Connecting microphone…"
                  : running
                    ? input === "microphone"
                      ? detectionState === "uncertain"
                        ? "Sound unclear — play one note at a time"
                        : detectionState === "settling"
                          ? "Listening for a clear pitch…"
                          : "Listening to your piano"
                      : "Keyboard practice"
                    : active === score.notes.length
                      ? "Practice complete"
                      : "Ready"}
              </strong>
              <span role="status">{message}</span>
            </div>
          </div>
          <div className="play-controls">
            <button className="icon" aria-label="Restart piece" onClick={reset}>
              <RotateCcw size={18} />
            </button>
            <button className="start" onClick={start} disabled={connecting}>
              {running ? (
                <Pause size={17} />
              ) : (
                <Play size={17} fill="currentColor" />
              )}
              {running ? "Pause" : "Start practice"}
            </button>
          </div>
          <div className="tempo">
            <label>
              Target tempo
              <div>
                <input
                  aria-label="Target BPM"
                  type="number"
                  min="30"
                  max="240"
                  value={bpmDraft}
                  onChange={(e) => setBpmDraft(e.target.value)}
                  onBlur={(e) => commitBpm(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitBpm(e.currentTarget.value);
                      e.currentTarget.blur();
                    }
                  }}
                />
                <span>BPM</span>
              </div>
            </label>
            <span className="actual">
              {measured ? `${measured} played` : "— played"}
            </span>
          </div>
        </div>
        <div className="mobile-message" role="status">
          {running && input === "microphone" && detectionState === "uncertain"
            ? "Sound unclear — play one note at a time."
            : message}
        </div>
        <div className="transport-sub">
          <button
            onClick={() => {
              stop();
              setInput(input === "microphone" ? "keyboard" : "microphone");
            }}
          >
            {input === "microphone" ? (
              <Mic size={13} />
            ) : (
              <Headphones size={13} />
            )}{" "}
            {input === "microphone" ? "Microphone" : "Keyboard demo"}{" "}
            <ChevronDown size={12} />
          </button>
          <span>
            Heard <b>{heard}</b>
            {running && input === "microphone" && pitchStatus.frequency !== undefined && (
              <> · {pitchStatus.frequency.toFixed(1)} Hz</>
            )}
          </span>
          <button
            onClick={() => {
              if (followPaused) setFollowPaused(false);
              else update("follow", !prefs.follow);
            }}
          >
            {prefs.follow && !followPaused ? (
              <Check size={13} />
            ) : (
              <ArrowUpRight size={13} />
            )}{" "}
            {followPaused
              ? "Resume following"
              : prefs.follow
                ? "Auto-follow on"
                : "Auto-follow off"}
          </button>
        </div>
        {input === "keyboard" && (
          <div className="keyboard">
            {["C", "D", "E", "F", "G", "A", "B", "C5", "D5"].map((n, i) => (
              <button
                key={i}
                disabled={!running}
                onClick={() => accept([60, 62, 64, 65, 67, 69, 71, 72, 74][i])}
              >
                {n}
                <small>{"ASDFGHJKL"[i]}</small>
              </button>
            ))}
          </div>
        )}
      </footer>
      {panel && (
        <>
          <button
            className="scrim"
            aria-label="Close panel"
            onClick={() => setPanel(null)}
          />
          <aside
            aria-label={
              panel === "settings" ? "Practice settings" : "Music library"
            }
          >
            <div className="panel-title">
              <h2>{panel === "settings" ? "Settings" : "Library"}</h2>
              <button
                className="icon"
                aria-label="Close panel"
                onClick={() => setPanel(null)}
              >
                <X size={20} />
              </button>
            </div>
            {panel === "library" ? (
              <>
                <button
                  className="upload"
                  onClick={() => file.current?.click()}
                >
                  <Upload size={20} />
                  <strong>Import sheet music</strong>
                  <span>MusicXML</span>
                </button>
                <input
                  ref={file}
                  hidden
                  type="file"
                  accept=".xml,.musicxml,.pdf"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void importFile(f);
                    e.target.value = "";
                  }}
                />
                <h3>Practice studies</h3>
                {[...demos, ...saved].map((s) => (
                  <button
                    key={s.id}
                    className="piece"
                    onClick={() => choose(s)}
                  >
                    <Music2 size={22} />
                    <span>
                      <strong>{s.title}</strong>
                      <small>
                        {s.composer !== "Original exercise" && s.composer !== "Unknown composer" ? `${s.composer} · ` : ""}{s.notes.length} notes
                      </small>
                    </span>
                    <ArrowUpRight size={17} />
                  </button>
                ))}
                <p className="fine">
                  Single-melody, treble-clef MusicXML. PDF import is not available.
                </p>
              </>
            ) : (
              <>
                <h3>Microphone</h3>
                <div className="setting-row">
                  <label htmlFor="microphone-input">Input</label>
                  <select
                    id="microphone-input"
                    value={prefs.microphoneId}
                    style={{ maxWidth: "65%" }}
                    onChange={(e) => {
                      stop();
                      update("microphoneId", e.target.value);
                    }}
                  >
                    <option value="">System default</option>
                    {prefs.microphoneId && !microphones.some((device) => device.deviceId === prefs.microphoneId) && (
                      <option value={prefs.microphoneId}>Saved input unavailable</option>
                    )}
                    {microphones.map((device, i) => (
                      <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${i + 1}`}</option>
                    ))}
                  </select>
                </div>
                {microphoneError && <p className="fine" role="status">{microphoneError}</p>}
                <div className="setting-row">
                  <label htmlFor="reference-a4">A4 reference (Hz)</label>
                  <input
                    id="reference-a4"
                    type="number"
                    min="400"
                    max="480"
                    step="0.1"
                    value={referenceDraft}
                    style={{ width: 82 }}
                    onChange={(e) => setReferenceDraft(e.target.value)}
                    onBlur={(e) => commitReference(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitReference(e.currentTarget.value);
                        e.currentTarget.blur();
                      }
                    }}
                  />
                </div>
                <div className="setting-row">
                  <span>Live pitch</span>
                  <output>{pitchStatus.frequency !== undefined
                    ? `${pitchStatus.frequency.toFixed(1)} Hz · ${Math.round(pitchStatus.cents ?? 0) >= 0 ? "+" : ""}${Math.round(pitchStatus.cents ?? 0)} cents`
                    : "—"}</output>
                </div>
                <h3>Reading</h3>
                <Toggle
                  title="Light appearance"
                  checked={prefs.light}
                  onChange={(v) => update("light", v)}
                />
                <Toggle
                  title="Note names"
                  checked={prefs.labels}
                  onChange={(v) => update("labels", v)}
                />
                <Toggle
                  title="Octave numbers"
                  checked={prefs.octaves}
                  onChange={(v) => update("octaves", v)}
                />
                <Toggle
                  title="Automatic following"
                  checked={prefs.follow}
                  onChange={(v) => update("follow", v)}
                />
                <h3>Feedback</h3>
                <div className="setting-row">
                  <label htmlFor="good">Correct note</label>
                  <input
                    id="good"
                    type="color"
                    value={prefs.good}
                    onChange={(e) => update("good", e.target.value)}
                  />
                </div>
                <div className="setting-row">
                  <label htmlFor="bad">Try again</label>
                  <input
                    id="bad"
                    type="color"
                    value={prefs.bad}
                    onChange={(e) => update("bad", e.target.value)}
                  />
                </div>
                <label className="range">
                  Overlay opacity{" "}
                  <span>{Math.round(prefs.opacity * 100)}%</span>
                  <input
                    type="range"
                    min="0.1"
                    max="0.7"
                    step="0.05"
                    value={prefs.opacity}
                    onChange={(e) => update("opacity", Number(e.target.value))}
                  />
                </label>
                <h3>Tempo</h3>
                <Toggle
                  title="Tempo guidance"
                  checked={prefs.tempoAdvice}
                  onChange={(v) => update("tempoAdvice", v)}
                />
                <label className="range">
                  Tempo tolerance<span>±{prefs.tolerance}%</span>
                  <input
                    type="range"
                    min="5"
                    max="30"
                    step="5"
                    value={prefs.tolerance}
                    onChange={(e) =>
                      update("tolerance", Number(e.target.value))
                    }
                  />
                </label>
                <p className="fine">
                  Microphone detection supports single notes. Chords and sustain pedal can affect accuracy.
                </p>
                <button
                  className="reset-settings"
                  onClick={() => {
                    stop();
                    changePracticeMode(defaults.practiceMode);
                    live.current.prefs = defaults;
                    setPrefs(defaults);
                  }}
                >
                  Restore defaults
                </button>
              </>
            )}
          </aside>
        </>
      )}
    </div>
  );
}
function Toggle({
  title,
  checked,
  onChange,
}: {
  title: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="setting-row">
      {title}
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
