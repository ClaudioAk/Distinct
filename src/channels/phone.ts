// Phone calls through Twilio Voice: call the assistant's number and just talk.
// Twilio turns your speech into text, DInstinct answers, Twilio reads the reply aloud.
// Tasks that take longer than a few seconds continue after the call and the result is
// texted to your primary channel. Every webhook is verified with Twilio's signature.
import { createHmac, timingSafeEqual } from "node:crypto";
import { digits } from "../config.ts";

/** Twilio request validation: HMAC-SHA1(authToken, fullUrl + sorted POST params), base64. */
export function twilioSignatureValid(authToken: string, fullUrl: string, params: URLSearchParams, signature: string | undefined): boolean {
  if (!authToken || !signature) return false;
  let data = fullUrl;
  for (const k of [...new Set(params.keys())].sort()) for (const v of params.getAll(k)) data += k + v;
  const expected = createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest();
  const got = Buffer.from(signature, "base64");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Text for speech: no links or markdown, and not too long. */
export function speakable(text: string, max = 700): string {
  let t = text.replace(/https?:\/\/\S+/g, "(link sent by text)").replace(/[*_#`>]/g, "").replace(/\n+/g, ". ");
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "") + ". I've texted you the rest.";
  return t;
}

export function twiml(o: { say?: string[]; gather?: { prompt: string; action: string }; hangup?: boolean; language: string }): string {
  const say = (s: string) => `<Say language="${xml(o.language)}">${xml(s)}</Say>`;
  let body = (o.say ?? []).map(say).join("");
  if (o.gather)
    body += `<Gather input="speech" action="${xml(o.gather.action)}" method="POST" speechTimeout="auto" language="${xml(o.language)}">${say(o.gather.prompt)}</Gather>${say("Talk soon. Bye!")}<Hangup/>`;
  else if (o.hangup) body += "<Hangup/>";
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

export const callerAllowed = (from: string, allowed: string[]) => allowed.map(digits).filter(Boolean).includes(digits(from));
