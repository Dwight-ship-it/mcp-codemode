// Out-of-band approval: the gateway asks the user itself with a native macOS dialog.
// The model never sees or controls this; a script can only wait for the answer.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Answer = "approve" | "approve-rest" | "deny" | "no-answer" | "dialog-failed";

export interface ApprovalRequest {
  client: string;
  server: string;
  tool: string;
  reason: string;
  args: unknown;
  untrustedSources: string[]; // tools read earlier in this script that returned outside content
  allowApproveRest: boolean;
  /** True once the script is over: a dialog still waiting in the queue is then skipped. */
  cancelled?: () => boolean;
}

const DIALOG = `on run argv
  set msg to item 1 of argv
  set allowRest to item 2 of argv
  if allowRest is "1" then
    set btns to {"Deny", "Approve rest of script", "Approve"}
  else
    set btns to {"Deny", "Approve"}
  end if
  try
    set r to display dialog msg with title "MCP Code Mode: approve this action?" buttons btns default button "Deny" cancel button "Deny" with icon caution giving up after 120
    if gave up of r then return "no-answer"
    set b to button returned of r
    if b is "Approve" then return "approve"
    if b is "Approve rest of script" then return "approve-rest"
    return "deny"
  on error errMsg number errNum
    if errNum is -128 then return "deny"
    return "dialog-failed"
  end try
end run`;

let queue: Promise<unknown> = Promise.resolve();

export function auditLog(path: string, entry: Record<string, unknown>) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 }); // may hold sensitive arguments
  } catch { /* audit must never break a call */ }
}

// Control, zero-width and text-direction characters can make a dialog read differently from what will run.
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
const visible = (s: string) => s.replace(HIDDEN, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const visibleLine = (s: string) => visible(s.replace(/\n/g, " ")).slice(0, 300);

// Compact JSON, so many short lines can't push the buttons off the screen.
const MAX_ARGS = 1800;
const formatArgs = (args: unknown) => visible(JSON.stringify(args ?? {}) ?? "{}");
/** Too long to show in full: the dialog says so, and "Approve rest of script" isn't offered. */
export const argsTooLong = (args: unknown) => formatArgs(args).length > MAX_ARGS;

export function formatRequest(r: ApprovalRequest): string {
  let args = formatArgs(r.args);
  if (args.length > MAX_ARGS) {
    const hidden = args.length - MAX_ARGS;
    args = `⚠︎ ${hidden} characters in the middle are NOT shown. Deny if you don't expect a large payload.\n${args.slice(0, MAX_ARGS - 600)}\n[… ${hidden} characters not shown …]\n${args.slice(-600)}`;
  }
  const lines = [
    `${r.server}.${r.tool}`,
    `Why it asks: ${visibleLine(r.reason)}`,
    `Agent: ${visibleLine(r.client)}`,
    "",
    `Arguments:`,
    args,
  ];
  if (r.untrustedSources.length) {
    lines.push("", `⚠︎ This script read outside content earlier (${[...new Set(r.untrustedSources)].join(", ")}). Check the arguments came from you, not from that content.`);
  }
  return lines.join("\n");
}

/** Shows one dialog at a time. Mode "dialog" is the real thing; test modes exist for automated tests only. */
export function requestApproval(r: ApprovalRequest, mode: "dialog" | "test-approve" | "test-deny"): Promise<Answer> {
  if (mode === "test-approve") return Promise.resolve("approve");
  if (mode === "test-deny") return Promise.resolve("deny");
  const run = () =>
    new Promise<Answer>((resolve) => {
      if (r.cancelled?.()) return resolve("deny");
      execFile("/usr/bin/osascript", ["-e", DIALOG, formatRequest(r), r.allowApproveRest && !argsTooLong(r.args) ? "1" : "0"], { timeout: 130_000 }, (err, stdout) => {
        const out = String(stdout || "").trim();
        if (err) return resolve("dialog-failed");
        resolve(out === "approve" || out === "approve-rest" || out === "no-answer" || out === "dialog-failed" ? out : "deny");
      });
    });
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}
