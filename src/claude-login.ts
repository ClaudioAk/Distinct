// "Sign in with Claude": no API key to copy.
// Uses Anthropic's own command-line tool (`ant`, installed with Windows' installer winget),
// which opens the browser for a normal Anthropic sign-in and stores a login profile on this PC.
// The Anthropic SDK reads that profile directly (`new Anthropic({ profile })`).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { audit } from "./config.ts";
import { diagnose } from "./netcheck.ts";

/** Sign-in profile name. Installs from before the rename used "dinstinct"; keep using it if that's the one on this PC. */
function pickProfile(): string {
  const dir = process.env.ANTHROPIC_CONFIG_DIR || path.join(process.env.APPDATA ?? "", "Anthropic");
  const has = (name: string) => fs.existsSync(path.join(dir, "configs", `${name}.json`));
  return !has("distinct") && has("dinstinct") ? "dinstinct" : "distinct";
}
export const PROFILE = pickProfile();

const KNOWN = [
  `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Links\\ant.exe`,
  "C:\\Program Files\\Anthropic\\ant\\ant.exe",
  "C:\\Program Files\\ant\\ant.exe",
];

/** winget sometimes installs into its package folder without adding a shortcut to PATH. */
function findInWingetPackages(): string {
  const root = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
  try {
    for (const dir of fs.readdirSync(root)) {
      if (!dir.startsWith("Anthropic.Ant_")) continue;
      const stack = [path.join(root, dir)];
      while (stack.length) {
        const d = stack.pop()!;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) stack.push(full);
          else if (e.name.toLowerCase() === "ant.exe") return full;
        }
      }
    }
  } catch {}
  return "";
}

export function findAnt(): string {
  for (const p of KNOWN) if (p && fs.existsSync(p)) return p;
  const fromPackages = findInWingetPackages();
  if (fromPackages) return fromPackages;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["ant"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : "";
}

/** Environment for `ant`: a stray API key would override the sign-in, so leave keys out. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_PROFILE;
  return env;
}

export class ClaudeLogin {
  state: "idle" | "installing" | "waiting" | "checking" | "ok" | "error" = "idle";
  message = "";
  account = "";

  run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      let out = "";
      const p = spawn(cmd, args, { env: cleanEnv(), windowsHide: true });
      const t = setTimeout(() => p.kill(), timeoutMs);
      p.stdout?.on("data", (b) => (out += b));
      p.stderr?.on("data", (b) => (out += b));
      p.on("error", (e) => {
        clearTimeout(t);
        resolve({ code: -1, out: String(e.message) });
      });
      p.on("exit", (code) => {
        clearTimeout(t);
        resolve({ code: code ?? -1, out });
      });
    });
  }

  /** Install the tool if needed, open the browser sign-in, then check it works. */
  async signIn(): Promise<boolean> {
    let ant = findAnt();
    if (!ant) {
      this.state = "installing";
      this.message = "Getting Anthropic's sign-in tool ready (about a minute)…";
      audit("claude_login_install");
      await this.run("winget", ["install", "--id", "Anthropic.Ant", "-e", "--silent", "--accept-source-agreements", "--accept-package-agreements"], 5 * 60_000);
      ant = findAnt();
      if (!ant) return this.fail("Couldn't install Anthropic's sign-in tool. Try again, or use \"I have a Claude key instead\" below.");
    }
    this.state = "waiting";
    this.message = "A browser window opened. Sign in to Anthropic there (or create a free account), then come back here.";
    const r = await this.run(ant, ["auth", "login", "--profile", PROFILE], 10 * 60_000);
    if (r.code !== 0) return this.fail("Sign-in didn't finish. Try again.");
    return this.check();
  }

  /** Confirms the saved sign-in works by listing models (free, no usage charge). */
  async check(): Promise<boolean> {
    this.state = "checking";
    this.message = "Checking…";
    try {
      const client = new Anthropic({ profile: PROFILE });
      await client.models.list({ limit: 1 });
      const status = findAnt() ? await this.run(findAnt(), ["auth", "status", "--profile", PROFILE], 20_000) : { out: "" };
      this.account = (status.out.match(/[\w.+-]+@[\w-]+\.[\w.]+/) ?? [""])[0];
      this.state = "ok";
      this.message = "";
      audit("claude_login_ok");
      return true;
    } catch (e: any) {
      const net = await diagnose();
      if (!net.ok) return this.fail(`You're signed in, but this PC can't reach Claude. ${net.message}`);
      return this.fail(`Signed in, but Claude didn't answer: ${String(e?.message ?? e).slice(0, 160)}`);
    }
  }

  async signOut(): Promise<void> {
    const ant = findAnt();
    if (ant) await this.run(ant, ["auth", "logout", "--profile", PROFILE], 30_000);
    this.state = "idle";
    this.account = "";
    audit("claude_logout");
  }

  fail(msg: string): false {
    this.state = "error";
    this.message = msg;
    audit("claude_login_failed");
    return false;
  }
}
