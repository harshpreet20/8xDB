// Server-side only. Reads OPENAI_API_KEY from Vercel project environment variables —
// never exposed to the browser. The Supabase anon key used here is public by design;
// all write access is gated inside Postgres by verify_admin_password(), not by this
// function, so a leaked anon key alone cannot write anything.

const SUPABASE_URL = "https://qpzfnpoijxfvpbzpfogl.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwemZucG9panhmdnBienBmb2dsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNjEzNDEsImV4cCI6MjA5OTYzNzM0MX0.gej_Q4ZPQsf8ulOG3XUFhc7IDkweigMfcXix-2zKdFw";

const SYSTEM_PROMPT = `You are analyzing new evidence for an ongoing commercial dispute between RCC
(the client, "Harshpreet Bhasin" and associates) and 8X Sports (the vendor), over jersey
order D24366 / D24708. A detailed evidence register already exists; you are drafting
ONE new addition to it based on newly supplied raw text (a chat excerpt, a paraphrased
call, a screenshot transcription, etc).

Follow these rules strictly, because they are the house style of the whole register:

1. FACTS ONLY. Anchor every claim to a specific date/time if one is given. If no exact
   time is available (e.g. a verbal call), say so explicitly rather than inventing one.
2. Never assert intent, motive, or that the vendor is "lying" — state what was said and
   what happened, and let the contradiction speak for itself. This document has to hold
   up if it is ever read by a lawyer or a tribunal.
3. If the new text describes two things that cannot both be true (a promise vs. what
   actually happened, or two different vendor statements), classify it as a "backtrack":
   two clearly separated positions (A = what was said/promised first, B = what
   contradicts it) plus a short, factual verdict sentence.
4. If the new text is a single new fact, statement, or event with no internal
   contradiction, classify it as an "event" for the chronological timeline.
5. If the source is a phone/video call with no transcript, say so in the note/quote so
   nobody mistakes it for a verified text message.
6. Keep quotes verbatim from the supplied text. Do not paraphrase a direct quote.
7. Output ONLY valid JSON matching exactly one of the two schemas below. No prose
   outside the JSON.

Schema for a backtrack:
{
  "kind": "backtrack",
  "title": "short factual headline",
  "ts": "date/time range as human text, e.g. '30 Jul, 12:42-13:31'",
  "a": { "label": "Position A — date/time or 'reported, no timestamp'", "q": "quote or paraphrase, flagged if not verbatim text" },
  "b": { "label": "Position B — date/time or 'reported, no timestamp'", "q": "quote or paraphrase" },
  "verdict": "one factual sentence connecting them, no speculation about motive"
}

Schema for an event:
{
  "kind": "event",
  "d": "date, e.g. '30 Jul'",
  "t": "time, e.g. '14:10', or a label like 'call, no timestamp'",
  "src": "Group | 1:1 | Call",
  "k": "breach | vendor | client | fact",
  "title": "short factual headline",
  "q": "verbatim quote if one exists, else omit this field",
  "qw": "who said it",
  "note": "1-3 sentences of factual context, cross-referencing dates already known if relevant"
}

Return exactly one JSON object, either kind. Nothing else.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    res.status(400).json({ error: "invalid JSON body" });
    return;
  }

  const { password, rawText } = body || {};
  if (!password || !rawText || !rawText.trim()) {
    res.status(400).json({ error: "password and rawText are required" });
    return;
  }

  // 1. Verify password server-side against Postgres BEFORE spending any OpenAI credits.
  const verifyResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/verify_admin_password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ pw: password }),
  });
  const verifyOk = await verifyResp.json().catch(() => false);
  if (verifyResp.status !== 200 || verifyOk !== true) {
    res.status(401).json({ error: "invalid password" });
    return;
  }

  // 2. Call OpenAI.
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "OPENAI_API_KEY is not configured on this Vercel project" });
    return;
  }

  let draft;
  try {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const aiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: rawText },
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
    draft = JSON.parse(content);
  } catch (e) {
    res.status(502).json({ error: "OpenAI response was not valid JSON", detail: String(e) });
    return;
  }

  // 3. Store as a draft (status='draft') via the same password-gated RPC.
  const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_draft_update`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      pw: password,
      p_kind: draft.kind === "backtrack" ? "backtrack" : "event",
      p_payload: draft,
      p_source_text: rawText,
    }),
  });

  if (!insertResp.ok) {
    const errText = await insertResp.text();
    res.status(502).json({ error: "failed to store draft", detail: errText });
    return;
  }
  const newId = await insertResp.json();

  res.status(200).json({ id: newId, draft });
}
