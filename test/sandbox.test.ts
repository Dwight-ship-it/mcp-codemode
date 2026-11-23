import { test } from "node:test";
import assert from "node:assert/strict";
import { runInSandbox } from "../src/sandbox.ts";

const run = (code: string, onCall = async (_s: string, _t: string, a: any) => a, timeoutMs = 10_000) =>
  runInSandbox({ code, servers: { demo: ["echo"] }, onCall, onLog: () => {}, timeoutMs });

test("returns values and relays tool calls", async () => {
  const r = await run(`const x = await demo.echo({ a: 1 }); return { got: x, n: 2 }`);
  assert.deepEqual(r, { ok: true, value: { got: { a: 1 }, n: 2 } });
});

test("accepts an async arrow function", async () => {
  const r = await run(`async () => { return 42 }`);
  assert.deepEqual(r, { ok: true, value: 42 });
});

test("unknown function gives a helpful error", async () => {
  const r = await run(`return await demo.nope({})`);
  assert.equal(r.ok, false);
  assert.match(r.error!, /does not exist/);
});

const escapes: Record<string, string> = {
  network: `return await fetch("https://example.com").then(r => r.status)`,
  "read file": `return await Deno.readTextFile("/etc/hosts")`,
  "write file": `await Deno.writeTextFile("/tmp/codemode-escape.txt", "x"); return "wrote"`,
  env: `return Deno.env.get("HOME")`,
  subprocess: `const o = await new Deno.Command("/bin/echo", { args: ["hi"] }).output(); return "ran"`,
  "remote import": `return await import("https://deno.land/std/version.ts")`,
  "remote import (esm.sh)": `return await import("https://esm.sh/is-odd")`,
  "npm import": `return await import("npm:is-odd")`,
  "node:fs": `return (await import("node:fs")).readFileSync("/etc/hosts", "utf8")`,
  "node:child_process": `return (await import("node:child_process")).execSync("id").toString()`,
  "node:net": `return await new Promise((ok, no) => import("node:net").then((n) => { const s = n.connect(80, "127.0.0.1", () => ok("connected")); s.on("error", no); }, no))`,
  "local import": `return await import("file:///etc/hosts")`,
  ffi: `return Deno.dlopen("/usr/lib/libSystem.B.dylib", {})`,
};
for (const [name, code] of Object.entries(escapes)) {
  test(`sandbox blocks ${name}`, async () => {
    const r = await run(code);
    assert.equal(r.ok, false, `${name} should fail, got ${JSON.stringify(r)}`);
  });
}

test("time limit kills busy loops", async () => {
  const r = await run(`while (true) {}`, undefined, 1500);
  assert.equal(r.ok, false);
  assert.match(r.error!, /timed out/);
});

test("time spent in host calls (e.g. waiting for approval) does not count", async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 2500)); return "ok"; };
  const r = await run(`return await demo.echo({})`, slow, 1500);
  assert.deepEqual(r, { ok: true, value: "ok" });
});

test("large non-ASCII values survive the pipe", async () => {
  const r = await run(`const s = "é€😀".repeat(60000); return (await demo.echo({ s })).s === s`);
  assert.deepEqual(r, { ok: true, value: true });
});

test("host errors become script exceptions", async () => {
  const deny = async () => { throw new Error("The user denied it"); };
  const r = await run(`try { await demo.echo({}) } catch (e) { return "caught: " + e.message }`, deny);
  assert.deepEqual(r, { ok: true, value: "caught: The user denied it" });
});
