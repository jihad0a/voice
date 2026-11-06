import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Engine = "deepgram" | "openai" | "none";

function activeEngine(): Engine {
  if (process.env.DEEPGRAM_API_KEY) return "deepgram";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "none";
}

export async function GET() {
  return NextResponse.json({ engine: activeEngine() });
}

export async function POST(req: Request) {
  const engine = activeEngine();
  if (engine === "none") {
    return NextResponse.json({ error: "No speech engine configured", engine }, { status: 501 });
  }

  const form = await req.formData();
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return NextResponse.json({ error: "No audio received" }, { status: 400 });
  }

  try {
    if (engine === "deepgram") {
      // Deepgram Nova-3: fastest + most accurate for rapid, short utterances.
      // numerals=true makes "one two three" come back as 1 2 3.
      const params = new URLSearchParams({
        model: "nova-3",
        language: process.env.SPEECH_LANGUAGE || "en",
        numerals: "true",
        punctuate: "false",
        smart_format: "false",
        filler_words: "false",
      });
      const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
          "Content-Type": audio.type || "audio/webm",
        },
        body: Buffer.from(await audio.arrayBuffer()),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const alt = data?.results?.channels?.[0]?.alternatives?.[0];
      const words: { start: number; end: number }[] = alt?.words ?? [];
      return NextResponse.json({
        engine,
        transcript: alt?.transcript ?? "",
        speechStart: words.length ? words[0].start : null,
        speechEnd: words.length ? words[words.length - 1].end : null,
      });
    }

    // OpenAI gpt-4o-transcribe (best OpenAI model), steered with a prompt.
    const body = new FormData();
    const ext = (audio.type || "audio/webm").includes("mp4") ? "mp4" : "webm";
    body.append("file", audio, `speech.${ext}`);
    body.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe");
    body.append("language", process.env.SPEECH_LANGUAGE || "en");
    body.append("temperature", "0");
    body.append(
      "prompt",
      "A patient is reading single digits aloud very quickly, one by one, for an eye test. " +
        "Output only the digits 1 to 9 separated by spaces, e.g. '4 7 2 9 1'.",
    );
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return NextResponse.json({ engine, transcript: data?.text ?? "", speechStart: null, speechEnd: null });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Transcription failed", engine },
      { status: 502 },
    );
  }
}
