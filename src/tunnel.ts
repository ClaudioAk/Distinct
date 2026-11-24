// One-click "reach me on my phone": runs a Cloudflare quick tunnel so links DInstinct sends
// (secure vault links, iMessage/WhatsApp/phone webhooks) work away from this PC.
// Only the public routes are reachable through it; the admin pages stay PC-only.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { audit } from "./config.ts";

const KNOWN = [
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
  `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\cloudflared.exe`,
];

export function findCloudflared(): string {
  for (const p of KNOWN) if (p && fs.existsSync(p)) return p;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["cloudflared"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : "";
}

export class Tunnel {
  port: number;
  onUrl: (url: string) => void;
  proc: ChildProcess | null = null;
  url = "";
  state: "off" | "installing" | "starting" | "on" | "error" = "off";
  message = "";

  constructor(port: number, onUrl: (url: string) => void) {
    this.port = port;
    this.onUrl = onUrl;
  }

  /** Installs the official Cloudflare tunnel app with Windows' own installer (winget). */
  install(): Promise<boolean> {
    this.state = "installing";
    this.message = "Installing the secure connection (about a minute)…";
    audit("tunnel_install");
    return new Promise((resolve) => {
      const p = spawn("winget", ["install", "--id", "Cloudflare.cloudflared", "-e", "--silent", "--accept-source-agreements", "--accept-package-agreements"], { windowsHide: true });
      p.on("error", () => {
        this.state = "error";
        this.message = "Couldn't run the Windows installer (winget). Install 'cloudflared' from Microsoft Store / winget, then try again.";
        resolve(false);
      });
      p.on("exit", () => {
        const ok = !!findCloudflared();
        this.state = ok ? "off" : "error";
        this.message = ok ? "" : "The install didn't finish. Try again, or restart the PC and retry.";
        resolve(ok);
      });
    });
  }

  async start(): Promise<void> {
    if (this.proc) return;
    let exe = findCloudflared();
    if (!exe) {
      if (!(await this.install())) return;
      exe = findCloudflared();
    }
    this.state = "starting";
    this.message = "Connecting…";
    this.url = "";
    const p = spawn(exe, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${this.port}`], { windowsHide: true });
    this.proc = p;
    const scan = (buf: Buffer) => {
      const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !this.url) {
        this.url = m[0];
        this.state = "on";
        this.message = "";
        audit("tunnel_on");
        this.onUrl(this.url);
      }
    };
    p.stdout?.on("data", scan);
    p.stderr?.on("data", scan);
    p.on("exit", () => {
      if (this.proc === p) {
        this.proc = null;
        if (this.state !== "off") {
          this.state = "error";
          this.message = "The secure connection stopped. Turn it on again.";
        }
      }
    });
  }

  stop(): void {
    this.state = "off";
    this.message = "";
    this.url = "";
    this.proc?.kill();
    this.proc = null;
  }
}
