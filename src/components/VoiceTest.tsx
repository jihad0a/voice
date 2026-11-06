"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type CellStatus,
  generateNumbers,
  gradeDigits,
  transcriptToDigits,
} from "@/lib/numbers";

type Phase = "idle" | "countdown" | "recording" | "processing" | "results";
type EngineName = "deepgram" | "openai" | "none" | "unknown";

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

const PER_LINE = 8;

const ENGINE_LABEL: Record<EngineName, string> = {
  deepgram: "Deepgram Nova-3 (high accuracy)",
  openai: "OpenAI gpt-4o-transcribe (high accuracy)",
  none: "Browser speech only (basic) — add an API key for high accuracy",
  unknown: "Checking speech engine…",
};

export default function VoiceTest() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [lines, setLines] = useState(4);
  const [numbers, setNumbers] = useState<number[]>([]);
  const [countdown, setCountdown] = useState(3);
  const [level, setLevel] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<EngineName>("unknown");
  const [usedEngine, setUsedEngine] = useState<string>("");
  const [transcript, setTranscript] = useState("");
  const [speechSeconds, setSpeechSeconds] = useState<number | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Record<number, CellStatus>>({});
  const [heardDigits, setHeardDigits] = useState<string[]>([]);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);
  const recordingRef = useRef(false);
  const browserCommitted = useRef("");
  const browserSession = useRef("");
  const timersRef = useRef<number[]>([]);

  useEffect(() => {
    // generated after mount to avoid server/client hydration mismatch
    setNumbers(generateNumbers(4 * PER_LINE));
    fetch("/api/transcribe")
      .then((r) => r.json())
      .then((d) => setEngine((d.engine as EngineName) ?? "none"))
      .catch(() => setEngine("none"));
  }, []);

  const cleanupMedia = useCallback(() => {
    recordingRef.current = false;
    timersRef.current.forEach((t) => window.clearTimeout(t));
    timersRef.current = [];
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    try {
      recogRef.current?.stop();
    } catch {}
    recogRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  useEffect(() => () => cleanupMedia(), [cleanupMedia]);

  const grade = useMemo(() => gradeDigits(numbers, heardDigits), [numbers, heardDigits]);

  const statusOf = (i: number): CellStatus => overrides[i] ?? grade.cells[i]?.status ?? "missed";

  const correctCount = useMemo(
    () => numbers.reduce((acc, _, i) => acc + (statusOf(i) === "correct" ? 1 : 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [numbers, grade, overrides],
  );

  function newNumbers(l = lines) {
    setNumbers(generateNumbers(l * PER_LINE));
  }

  function changeLines(l: number) {
    setLines(l);
    newNumbers(l);
  }

  function startBrowserRecognition() {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    browserCommitted.current = "";
    browserSession.current = "";
    if (!Ctor) return;
    const launch = () => {
      const r = new Ctor();
      r.continuous = true;
      r.interimResults = true;
      r.lang = "en-US";
      r.onresult = (e) => {
        browserSession.current = Array.from(e.results)
          .map((res) => res[0].transcript)
          .join(" ");
      };
      r.onend = () => {
        browserCommitted.current += " " + browserSession.current;
        browserSession.current = "";
        if (recordingRef.current) {
          try {
            launch();
          } catch {}
        }
      };
      r.onerror = () => {};
      recogRef.current = r;
      try {
        r.start();
      } catch {}
    };
    launch();
  }

  async function start() {
    setError(null);
    setOverrides({});
    setTranscript("");
    setHeardDigits([]);
    setSpeechSeconds(null);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Microphone access is not available. Use HTTPS and a modern browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true, autoGainControl: true },
      });
      streamRef.current = stream;

      // Level meter so the examiner can see the mic is picking up the voice.
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(Math.min(1, peak / 64));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      setError("Could not access the microphone. Please allow microphone permission and try again.");
      cleanupMedia();
      return;
    }

    setPhase("countdown");
    setCountdown(3);
    [1, 2].forEach((s) => {
      timersRef.current.push(window.setTimeout(() => setCountdown(3 - s), s * 1000));
    });
    timersRef.current.push(window.setTimeout(beginRecording, 3000));
  }

  function beginRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
    recorderRef.current = rec;
    rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
    rec.onstop = () => void finish(new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" }));
    rec.start(250);
    recordingRef.current = true;
    startedAtRef.current = performance.now();
    setElapsed(0);
    startBrowserRecognition();
    setPhase("recording");
    const iv = window.setInterval(() => {
      if (!recordingRef.current) return window.clearInterval(iv);
      setElapsed((performance.now() - startedAtRef.current) / 1000);
    }, 100);
  }

  function stop() {
    const total = (performance.now() - startedAtRef.current) / 1000;
    setElapsed(total);
    recordingRef.current = false;
    setPhase("processing");
    try {
      recogRef.current?.stop();
    } catch {}
    if (recorderRef.current && recorderRef.current.state !== "inactive") recorderRef.current.stop();
  }

  async function finish(blob: Blob) {
    setAudioUrl(URL.createObjectURL(blob));
    // give the browser recogniser a moment to flush its last result
    await new Promise((r) => setTimeout(r, 400));
    const browserText = (browserCommitted.current + " " + browserSession.current).trim();
    cleanupMedia();

    let text = "";
    let used = "";
    let sStart: number | null = null;
    let sEnd: number | null = null;
    let note: string | null = null;

    if (engine !== "none") {
      try {
        const fd = new FormData();
        fd.append("audio", blob, "speech.webm");
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Transcription failed");
        text = data.transcript ?? "";
        used = data.engine === "deepgram" ? "Deepgram Nova-3" : "OpenAI gpt-4o-transcribe";
        sStart = data.speechStart;
        sEnd = data.speechEnd;
      } catch (e) {
        note = `High-accuracy engine failed (${e instanceof Error ? e.message : "error"}); used browser speech instead.`;
      }
    }
    if (!used) {
      text = browserText;
      used = "Browser speech (basic)";
    }

    if (!transcriptToDigits(text).length) {
      setError(note ?? "No numbers were heard. Check the microphone and speak clearly, then try again.");
      setPhase("idle");
      return;
    }
    if (note) setError(note);
    setUsedEngine(used);
    setTranscript(text);
    setHeardDigits(transcriptToDigits(text));
    setSpeechSeconds(sStart !== null && sEnd !== null ? sEnd - sStart : null);
    setPhase("results");
  }

  function toggle(i: number) {
    if (phase !== "results") return;
    setOverrides((o) => ({ ...o, [i]: statusOf(i) === "correct" ? "wrong" : "correct" }));
  }

  function reset(sameNumbers: boolean) {
    setError(null);
    setPhase("idle");
    if (!sameNumbers) newNumbers();
  }

  const rows = Array.from({ length: lines }, (_, r) => numbers.slice(r * PER_LINE, (r + 1) * PER_LINE));
  const total = numbers.length;
  const duration = speechSeconds ?? elapsed;
  const showNumbers = phase !== "countdown";

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-6 sm:px-8">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Rapid Number Reading Test</h1>
          <p className="text-sm text-slate-500">
            Patient reads the numbers aloud, left to right, as fast as possible.
          </p>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            engine === "deepgram" || engine === "openai"
              ? "bg-emerald-100 text-emerald-800"
              : engine === "none"
                ? "bg-amber-100 text-amber-800"
                : "bg-slate-200 text-slate-600"
          }`}
        >
          {ENGINE_LABEL[engine]}
        </span>
      </header>

      {/* Number card */}
      <main className="relative flex-1">
        <div className="relative rounded-3xl bg-white p-6 shadow-lg ring-1 ring-slate-200 sm:p-10">
          <div
            className={`flex flex-col gap-4 sm:gap-7 transition-opacity ${showNumbers ? "opacity-100" : "opacity-0"}`}
            aria-hidden={!showNumbers}
          >
            {rows.map((row, r) => (
              <div key={r} className="flex justify-between">
                {row.map((n, c) => {
                  const i = r * PER_LINE + c;
                  const st = phase === "results" ? statusOf(i) : null;
                  const cell = grade.cells[i];
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => toggle(i)}
                      disabled={phase !== "results"}
                      title={phase === "results" ? "Click to override" : undefined}
                      className={`relative flex aspect-square w-[10.5%] items-center justify-center rounded-xl font-mono text-[clamp(1.75rem,6.5vw,4.75rem)] font-semibold leading-none transition-colors ${
                        st === "correct"
                          ? "bg-emerald-500 text-white"
                          : st === "wrong" || st === "missed"
                            ? "bg-red-500 text-white"
                            : "text-slate-900"
                      } ${phase === "results" ? "cursor-pointer hover:brightness-95" : "cursor-default"}`}
                    >
                      {n}
                      {st && st !== "correct" && (
                        <span className="absolute bottom-0.5 right-1.5 text-[clamp(0.6rem,1.4vw,0.95rem)] font-medium opacity-90">
                          {cell?.status === "wrong" && statusOf(i) === "wrong" ? `said ${cell.heard}` : "skipped"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {phase === "countdown" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <div className="text-[10rem] font-bold leading-none text-slate-900">{countdown}</div>
              <p className="text-lg text-slate-500">Get ready — numbers appear next</p>
            </div>
          )}
          {phase === "processing" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-3xl bg-white/90">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-300 border-t-slate-900" />
              <p className="text-lg font-medium">Analysing speech…</p>
            </div>
          )}
        </div>

        {error && (
          <p className="mt-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">{error}</p>
        )}

        {/* Controls */}
        <section className="mt-5 rounded-2xl bg-white p-5 shadow ring-1 ring-slate-200">
          {phase === "idle" && (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3 text-sm">
                <span className="text-slate-500">Lines</span>
                {[2, 3, 4, 5].map((l) => (
                  <button
                    key={l}
                    onClick={() => changeLines(l)}
                    className={`h-9 w-9 rounded-lg font-medium ${
                      lines === l ? "bg-slate-900 text-white" : "bg-slate-100 hover:bg-slate-200"
                    }`}
                  >
                    {l}
                  </button>
                ))}
                <button onClick={() => newNumbers()} className="ml-2 rounded-lg bg-slate-100 px-3 py-2 hover:bg-slate-200">
                  Shuffle numbers
                </button>
              </div>
              <button
                onClick={start}
                className="rounded-xl bg-blue-600 px-8 py-3 text-lg font-semibold text-white shadow hover:bg-blue-700"
              >
                🎤 Start test
              </button>
            </div>
          )}

          {phase === "countdown" && <p className="text-center text-slate-500">Microphone is on. Starting…</p>}

          {phase === "recording" && (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-1 items-center gap-4">
                <span className="relative flex h-3 w-3">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex h-3 w-3 rounded-full bg-red-600" />
                </span>
                <span className="font-semibold">Listening</span>
                <span className="font-mono text-xl tabular-nums">{elapsed.toFixed(1)}s</span>
                <div className="h-3 min-w-24 max-w-xs flex-1 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-[width] duration-75"
                    style={{ width: `${Math.round(level * 100)}%` }}
                  />
                </div>
              </div>
              <button
                onClick={stop}
                className="rounded-xl bg-slate-900 px-8 py-3 text-lg font-semibold text-white shadow hover:bg-slate-700"
              >
                ■ Finish
              </button>
            </div>
          )}

          {phase === "processing" && <p className="text-center text-slate-500">Please wait…</p>}

          {phase === "results" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-6">
                <Stat label="Correct" value={`${correctCount} / ${total}`} tone="green" />
                <Stat label="Errors" value={String(total - correctCount)} tone="red" />
                <Stat label="Accuracy" value={`${Math.round((correctCount / total) * 100)}%`} />
                <Stat label={speechSeconds !== null ? "Reading time" : "Total time"} value={`${duration.toFixed(1)}s`} />
                {grade.extra > 0 && <Stat label="Extra numbers said" value={String(grade.extra)} />}
              </div>
              <div className="rounded-xl bg-slate-50 p-3 text-sm">
                <span className="font-medium text-slate-600">Heard ({usedEngine}): </span>
                <span className="font-mono">{heardDigits.join(" ")}</span>
                <details className="mt-1 text-slate-500">
                  <summary className="cursor-pointer">Raw transcript</summary>
                  <p className="mt-1 break-words">{transcript}</p>
                </details>
              </div>
              {audioUrl && <audio controls src={audioUrl} className="w-full" />}
              <p className="text-xs text-slate-500">Tip: click any number to override the result manually.</p>
              <div className="flex flex-wrap gap-3">
                <button
                  onClick={() => reset(false)}
                  className="rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white hover:bg-blue-700"
                >
                  New test (new numbers)
                </button>
                <button
                  onClick={() => reset(true)}
                  className="rounded-xl bg-slate-100 px-6 py-3 font-semibold hover:bg-slate-200"
                >
                  Repeat same numbers
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "green" | "red" }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div
        className={`text-2xl font-bold tabular-nums ${
          tone === "green" ? "text-emerald-600" : tone === "red" ? "text-red-600" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}
