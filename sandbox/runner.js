// Runs one model-written script inside Deno with NO permissions
// (no net, files, env, subprocesses or FFI). The only way out is this
// process's stdin/stdout, which the gateway reads as tool-call requests.
// Every request is checked by the gateway's policy before anything runs.

const enc = new TextEncoder();
const out = Deno.stdout;
const send = (msg) => out.write(enc.encode(JSON.stringify(msg) + "\n"));

const pending = new Map();
let nextId = 1;

function hostCall(server, tool, args) {
  const id = nextId++;
  send({ type: "call", id, server, tool, args: args ?? {} });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function fmt(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
const sandboxConsole = {};
for (const level of ["log", "info", "warn", "error", "debug"]) {
  sandboxConsole[level] = (...a) => send({ type: "log", level, text: a.map(fmt).join(" ") });
}

function normalize(code) {
  const c = code.trim().replace(/^```(?:ts|typescript|js|javascript)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  // Accept `async () => { ... }` and `async function () { ... }` as well as a plain body.
  if (/^async\s*(\(\s*\)|function\s*\w*\s*\(\s*\))\s*(=>)?\s*\{[\s\S]*\}\s*;?$/.test(c)) return `return await (${c.replace(/;\s*$/, "")})();`;
  return c;
}

async function run(msg) {
  const names = Object.keys(msg.servers);
  const namespaces = names.map((server) => {
    const ns = {};
    for (const tool of msg.servers[server]) ns[tool] = (args) => hostCall(server, tool, args);
    ns.$resource = (uri) => hostCall("$", "resource", { server, uri });
    return new Proxy(ns, {
      get(target, prop) {
        if (prop in target || typeof prop === "symbol") return target[prop];
        throw new TypeError(`${server}.${String(prop)} does not exist. Use search_tools to find the right name.`);
      },
    });
  });
  const show = (value) => hostCall("$", "show", { value });
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    const fn = new AsyncFunction(...names, "show", "console", '"use strict";\n' + normalize(msg.code));
    const value = await fn(...namespaces, show, sandboxConsole);
    await send({ type: "done", ok: true, value: value === undefined ? null : value });
  } catch (e) {
    await send({ type: "done", ok: false, error: e && e.fromHost ? String(e.message) : e && e.stack ? String(e.stack).split("\n").slice(0, 4).join("\n") : String(e) });
  }
}

let buf = "";
const dec = new TextDecoder();
for await (const chunk of Deno.stdin.readable) {
  buf += dec.decode(chunk, { stream: true });
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "run") run(msg);
    else if (msg.type === "result") {
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.value);
      else { const e = new Error(msg.error); e.fromHost = true; p.reject(e); }
    }
  }
}
