import { createRuntime } from "mcporter";
const rt = await createRuntime({ configPath: new URL("../config/mcporter.json", import.meta.url).pathname });
const only = process.argv.slice(2);
await Promise.all(rt.listServers().filter((s) => !only.length || only.includes(s)).map(async (s) => {
  try { const t = await rt.listTools(s, { disableOAuth: true, timeoutMs: 90_000 }); console.log(`## ${s} (${t.length}): ${t.map((x) => x.name).join(", ")}`); }
  catch (e: any) { console.log(`## ${s}: ERROR ${String(e.message).slice(0, 200)}`); }
}));
await rt.close(); process.exit(0);
