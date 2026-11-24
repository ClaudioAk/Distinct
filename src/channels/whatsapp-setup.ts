// Guided WhatsApp setup through Meta's Graph API, so the owner only pastes three things
// (App ID, App secret, access token) and Distinct does the rest:
//  - checks each one right away
//  - finds the WhatsApp Business account and phone number from the token
//  - registers its own webhook with Meta (and re-registers when the secure address changes)
//  - sends a test message
const graphUrl = (v: string, p: string) => `https://graph.facebook.com/${v}/${p.replace(/^\//, "")}`;

async function graph(method: "GET" | "POST", url: string, opts: { bearer?: string; form?: Record<string, string>; json?: unknown } = {}): Promise<any> {
  const headers: Record<string, string> = {};
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  let body: string | undefined;
  if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.json) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const r = await fetch(url, { method, headers, body });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(friendly(j.error?.message ?? `Meta said ${r.status}`));
  return j;
}

function friendly(m: string): string {
  if (/Error validating application|Invalid OAuth access token|Malformed access token/i.test(m)) return "Meta didn't accept that. Copy it again (the whole thing).";
  if (/Session has expired|expired/i.test(m)) return "That access token has expired. Generate a new one in Meta (WhatsApp → API Setup).";
  if (/client secret|app secret/i.test(m)) return "That App secret doesn't match the App ID.";
  if (/(#131030)|not in allowed list|Recipient phone number not in allowed list/i.test(m))
    return "Meta's test number can only message numbers you add first: in Meta's API Setup, put your number in the 'To' field and confirm the code WhatsApp sends you.";
  if (/callback|verify/i.test(m)) return `Meta couldn't reach Distinct to check the connection (${m}). Make sure "Reach me on my phone" is on, then try again.`;
  return m;
}

/** App ID + App secret must belong together. Returns the app's name. */
export async function checkApp(v: string, appId: string, secret: string): Promise<string> {
  if (!/^\d{5,25}$/.test(appId)) throw new Error("The App ID is a long number (shown at the top of your Meta app's dashboard).");
  if (!/^[a-f0-9]{32}$/i.test(secret)) throw new Error("The App secret is 32 letters and numbers (App settings → Basic → App secret → Show).");
  const j = await graph("GET", graphUrl(v, `${appId}?fields=id,name&access_token=${encodeURIComponent(`${appId}|${secret}`)}`));
  return j.name ?? "your app";
}

export type TokenInfo = { appId: string; wabaIds: string[]; expiresAt: number; valid: boolean };

/** Reads what a token can reach (using the app token, which always may inspect its own tokens). */
export async function inspectToken(v: string, appId: string, secret: string, token: string): Promise<TokenInfo> {
  const j = await graph("GET", graphUrl(v, `debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${appId}|${secret}`)}`));
  const d = j.data ?? {};
  if (!d.is_valid) throw new Error("Meta says this access token isn't valid. Generate a new one in WhatsApp → API Setup.");
  if (String(d.app_id) !== appId) throw new Error("This access token belongs to a different Meta app than the App ID you entered.");
  const wabaIds = new Set<string>();
  for (const g of d.granular_scopes ?? []) if (/^whatsapp_business_(management|messaging)$/.test(g.scope)) for (const id of g.target_ids ?? []) wabaIds.add(String(id));
  if (!(d.scopes ?? []).includes("whatsapp_business_messaging")) throw new Error("This token doesn't have WhatsApp permission. Generate it from WhatsApp → API Setup.");
  return { appId: String(d.app_id), wabaIds: [...wabaIds], expiresAt: (d.expires_at ?? 0) * 1000, valid: true };
}

export type WaNumber = { id: string; display: string; name: string; wabaId: string };

export async function listNumbers(v: string, token: string, wabaIds: string[]): Promise<WaNumber[]> {
  const out: WaNumber[] = [];
  for (const w of wabaIds) {
    const j = await graph("GET", graphUrl(v, `${w}/phone_numbers?fields=id,display_phone_number,verified_name`), { bearer: token });
    for (const n of j.data ?? []) out.push({ id: String(n.id), display: n.display_phone_number, name: n.verified_name ?? "", wabaId: w });
  }
  return out;
}

/**
 * Points WhatsApp messages at Distinct, following Meta's documented steps:
 *  1. subscribe the app to the WhatsApp Business ("Messaging") account: POST /{waba}/subscribed_apps (no body)
 *  2. override that account's webhook address: POST /{waba}/subscribed_apps {override_callback_uri, verify_token}
 *     (Meta then calls our webhook once to verify it).
 * Also sets the app-level "messages" webhook as a fallback; if that call isn't allowed it's skipped.
 * Returns which parts worked, so the page can show the manual steps when needed.
 */
export async function connectWebhook(
  v: string,
  o: { appId: string; secret: string; token: string; wabaId: string; callbackUrl: string; verifyToken: string },
): Promise<{ override: boolean; appLevel: boolean }> {
  let appLevel = true;
  try {
    await graph("POST", graphUrl(v, `${o.appId}/subscriptions`), {
      form: { object: "whatsapp_business_account", callback_url: o.callbackUrl, verify_token: o.verifyToken, fields: "messages", access_token: `${o.appId}|${o.secret}` },
    });
  } catch {
    appLevel = false;
  }
  await graph("POST", graphUrl(v, `${o.wabaId}/subscribed_apps`), { bearer: o.token });
  let override = true;
  try {
    await graph("POST", graphUrl(v, `${o.wabaId}/subscribed_apps`), { bearer: o.token, json: { override_callback_uri: o.callbackUrl, verify_token: o.verifyToken } });
  } catch (e) {
    override = false;
    if (!appLevel) throw e; // neither way worked: show Meta's reason
  }
  return { override, appLevel };
}

/** Meta's ready-made "hello_world" template: the only message a business may send before you write first. */
export async function sendHello(v: string, phoneId: string, token: string, to: string): Promise<void> {
  await graph("POST", graphUrl(v, `${phoneId}/messages`), {
    bearer: token,
    json: { messaging_product: "whatsapp", to: to.replace(/\D/g, ""), type: "template", template: { name: "hello_world", language: { code: "en_US" } } },
  });
}
