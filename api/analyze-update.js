// Server-side only. Reads OPENAI_API_KEY from Vercel project environment variables —
// never exposed to the browser. Callers must present a valid Supabase session access
// token (Authorization: Bearer <token>) belonging to marketing.hotbot@gmail.com; this
// function verifies that with Supabase's own /auth/v1/user endpoint before spending
// any OpenAI credits. It never writes to the database itself — it only returns
// structured drafts, which the browser then inserts using its own authenticated
// session (so Postgres RLS is the real, single source of truth for who can write).

const SUPABASE_URL = "https://qpzfnpoijxfvpbzpfogl.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwemZucG9panhmdnBienBmb2dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNjEzNDEsImV4cCI6MjA5OTYzNzM0MX0.gej_Q4ZPQsf8ulOG3XUFhc7IDkweigMfcXix-2zKdFw";
const ALLOWED_EMAIL = "marketing.hotbot@gmail.com";

const SYSTEM_PROMPT = `You are analyzing new evidence for an ongoing commercial dispute between RCC
(the client, "Harshpreet Bhasin" and associates) and 8X Sports (the vendor), over jersey
order D24366 / D24708. A detailed evidence register already exists; you are drafting
new additions to it based on newly supplied material: pasted chat text, screenshots
(read any visible text/timestamps directly from the image), a WhatsApp chat export
dump, or a paraphrased call.

House style rules — follow them strictly, this document has to hold up if read by a
lawyer or a tribunal:

1. FACTS ONLY, timestamp-anchored wherever a timestamp is available. If no exact time
   exists (e.g. a verbal call), say so explicitly rather than inventing one.
2. Never assert intent, motive, or that anyone is "lying" — state what was said and
   what happened, and let any contradiction speak for itself.
3. If the material shows two things that cannot both be true (a promise vs. what
   actually happened, or two different statements from the same party), classify it as
   a "backtrack": two clearly separated positions plus a short factual verdict.
4. If the material is a single new fact/statement/event with no internal contradiction,
   classify it as an "event" for the chronological timeline.
5. Keep quotes verbatim. Do not paraphrase a direct quote you can read exactly.
6. A single submission may contain MULTIPLE noteworthy items (e.g. a chat export dump).
   Extract each one separately. Skip routine/non-substantive lines (plain "ok", missed
   call logs with no content, etc.) — only extract items that add real evidentiary
   value: commitments, contradictions, payments, dispatch dates, quality complaints,
   refusals, quality/spec claims, silences, or anything a reader would want on record.
7. Output ONLY valid JSON: { "items": [ ... ] }, where each item matches exactly one of
   the two schemas below. If nothing extractable is found, return { "items": [] }.

Schema for a backtrack item:
{ "kind": "backtrack", "title": "short factual headline",
  "ts": "date/time range as human text",
  "a": { "label": "Position A — date/time or 'reported, no timestamp'", "q": "quote or paraphrase" },
  "b": { "label": "Position B — date/time or 'reported, no timestamp'", "q": "quote or paraphrase" },
  "verdict": "one factual sentence connecting them, no speculation about motive" }

Schema for an event item:
{ "kind": "event", "d": "date, e.g. '30 Jul'", "t": "time or a label like 'call, no timestamp'",
  "src": "Group | 1:1 | Call", "k": "breach | vendor | client | fact",
  "title": "short factual headline", "q": "verbatim quote if one exists (omit if none)",
  "qw": "who said it", "note": "1-3 sentences of factual context" }`;

async function verifyCaller(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json().catch(() => null);
  if (!user || user.email !== ALLOWED_EMAIL) return null;
  return user;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const user = await verifyCaller(req);
  if (!user) {
    res.status(401).json({ error: "not authenticated as an authorized user" });
    return;
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }

  const { rawText, images } = body || {};
  const hasText = rawText && rawText.trim();
  const hasImages = Array.isArray(images) && images.length > 0;
  if (!hasText && !hasImages) {
    res.status(400).json({ error: "provide rawText and/or images" });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY is not configured on this Vercel project" });
    return;
  }

  const userContent = [];
  if (hasText) userContent.push({ type: "text", text: rawText });
  if (hasImages) {
    for (const img of images.slice(0, 8)) {
      if (img && img.dataUrl) userContent.push({ type: "image_url", image_url: { url: img.dataUrl } });
    }
  }

  let items = [];
  try {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });
    if (!aiResp.ok) {
      const errText = await aiResp.text();
      res.status(502).json({ error: "OpenAI request failed", detail: errText });
      return;
    }
    const aiJson = await aiResp.json();
    const content = aiJson.choices?.[0]?.message?.content;
    const parsed = JSON.parse(content);
    items = Array.isArray(parsed.items) ? parsed.items : [];
  } catch (e) {
    res.status(502).json({ error: "OpenAI response was not valid JSON", detail: String(e) });
    return;
  }

  res.status(200).json({ items });
}
