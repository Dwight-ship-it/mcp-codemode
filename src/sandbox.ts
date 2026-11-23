// Host side of the Deno sandbox: spawn, relay tool calls, enforce limits.
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../sandbox/runner.js", import.meta.url));

export const DENO_ARGS = [
  "run",
  "--no-config", "--no-lock", "--no-npm", "--no-remote", "--no-prompt", "--quiet",
  "--v8-flags=--max-old-space-size=256",
  RUNNER,
];

export interface RunOptions {
  code: string;
  servers: Record<string, string[]>; // namespace -> tool js names
  onCall: (server: string, tool: string, args: any) => Promise<unknown>;
  onLog: (level: string, text: string) => void;
  /** Wall-clock limit for script execution, not counting time spent waiting for the user. */
  timeoutMs: number;
  deno?: string;
}

export interface RunOutcome { ok: boolean; value?: unknown; error?: string }

export function runInSandbox(o: RunOptions): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawn(o.deno ?? "deno", DENO_ARGS, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin:/opt/homebrew/bin", DENO_NO_UPDATE_CHECK: "1", NO_COLOR: "1", HOME: process.env.HOME ?? "" },
    });
    let finished = false;
    let stderr = "";
    let paused = 0; // ms spent waiting for host work (tool calls, approvals)
    const started = Date.now();
    const finish = (r: RunOutcome) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      child.kill("SIGKILL");
      resolve(r);
    };
    let inFlight = 0;
    let pauseStart = 0;
    const timer = setInterval(() => {
      const now = Date.now();
      const busy = inFlight > 0 ? now - pauseStart : 0;
      if (now - started - paused - busy > o.timeoutMs) finish({ ok: false, error: `Script timed out after ${o.timeoutMs / 1000}s of run time.` });
    }, 250);

    const write = (msg: unknown) => { if (!finished) child.stdin.write(JSON.stringify(msg) + "\n"); };
    child.stdin.on("error", () => {}); // a script can close its stdin; that must not take the gateway down
    const decoder = new StringDecoder("utf8"); // chunks can split a multi-byte character
    let buf = "";
    let outBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > 50_000_000) return finish({ ok: false, error: "Script produced too much output." });
      buf += decoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { o.onLog("warn", line.slice(0, 500)); continue; }
        if (msg.type === "log") o.onLog(String(msg.level), String(msg.text));
        else if (msg.type === "done") finish(msg.ok ? { ok: true, value: msg.value } : { ok: false, error: String(msg.error) });
        else if (msg.type === "call") {
          if (inFlight++ === 0) pauseStart = Date.now();
          o.onCall(String(msg.server), String(msg.tool), msg.args ?? {}).then(
            (value) => write({ type: "result", id: msg.id, ok: true, value }),
            (err) => write({ type: "result", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
          ).finally(() => {
            if (--inFlight === 0) paused += Date.now() - pauseStart;
          });
        }
      }
    });
    child.stderr.on("data", (c: Buffer) => { if (stderr.length < 8000) stderr += c.toString("utf8"); });
    child.on("error", (e) => finish({ ok: false, error: `Sandbox failed to start: ${e.message}` }));
    child.on("exit", (code) => finish({ ok: false, error: `Sandbox exited (${code}) before the script finished.${stderr ? "\n" + stderr.trim().slice(0, 1500) : ""}` }));
    write({ type: "run", code: o.code, servers: o.servers });
  });
}
