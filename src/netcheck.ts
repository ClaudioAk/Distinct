// Explains connection problems in plain words. The common one on company networks: a firewall
// (Fortinet, Zscaler, Palo Alto, Sophos…) re-signs secure connections with its own certificate,
// which this PC doesn't fully trust, so the connection to Claude is refused.
import tls from "node:tls";
import fs from "node:fs";
import { X509Certificate } from "node:crypto";

export type NetDiagnosis = { ok: boolean; intercepted: boolean; issuer: string; message: string };

export function diagnose(host = "api.anthropic.com"): Promise<NetDiagnosis> {
  return new Promise((resolve) => {
    const done = (d: NetDiagnosis) => {
      clearTimeout(timer);
      resolve(d);
    };
    const timer = setTimeout(
      () => done({ ok: false, intercepted: false, issuer: "", message: `Can't reach ${host}. Check the internet connection.` }),
      10_000,
    );
    const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const cert = s.getPeerCertificate();
      const issuer = [cert?.issuer?.CN, cert?.issuer?.O].filter(Boolean).join(" / ");
      const err = s.authorizationError ? String(s.authorizationError) : "";
      s.end();
      if (!err) return done({ ok: true, intercepted: false, issuer, message: "" });
      done({
        ok: false,
        intercepted: true,
        issuer,
        message:
          `Your network's firewall (${issuer || "unknown"}) is inspecting secure connections, so this PC can't reach Claude safely. ` +
          `Fix: ask your IT team to exclude api.anthropic.com from SSL inspection, or to give you the firewall's certificate and add it in Settings → Advanced → Company network certificate.`,
      });
    });
    s.on("error", (e) => done({ ok: false, intercepted: false, issuer: "", message: `Can't reach ${host}: ${e.message}` }));
  });
}

/** Checks a pasted company certificate: must be a real CA certificate in PEM form. Returns its name. */
export function validateCompanyCA(pem: string): string {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length) throw new Error("That isn't a certificate. Paste the text that starts with -----BEGIN CERTIFICATE-----.");
  const names: string[] = [];
  for (const b of blocks) {
    const c = new X509Certificate(b);
    if (!c.ca) throw new Error(`"${c.subject.replace(/\n/g, ", ")}" is not a certificate authority, so it can't be used here.`);
    names.push((c.subject.match(/CN=([^\n]+)/) ?? [, c.subject])[1]!);
  }
  return names.join(", ");
}

/** Trusts the saved company certificate for every secure connection from now on (no restart needed). */
export function applyCompanyCA(file: string): string {
  if (!fs.existsSync(file)) return "";
  const pem = fs.readFileSync(file, "utf8");
  const name = validateCompanyCA(pem);
  const extra = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!;
  const anyTls = tls as any;
  if (typeof anyTls.setDefaultCACertificates === "function") {
    const base = [...new Set([...anyTls.getCACertificates("default"), ...anyTls.getCACertificates("system")])];
    anyTls.setDefaultCACertificates([...base, ...extra]);
  }
  return name;
}

const TLS_CODES = /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT|CERT_UNTRUSTED|certificate/i;

/** True when an error (or its cause chain) is a certificate problem. */
export function isCertError(err: any): boolean {
  for (let e = err, i = 0; e && i < 5; e = e.cause, i++) if (TLS_CODES.test(`${e.code ?? ""} ${e.message ?? ""}`)) return true;
  return false;
}
