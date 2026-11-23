import { createRuntime } from "mcporter";
import { mkdirSync, writeFileSync } from "node:fs";
import { craftCommandVerdict } from "../src/policy.ts";
const rt = await createRuntime({ configPath: new URL("../config/mcporter.json", import.meta.url).pathname });
const lists: Record<string, string> = { pdfcraft: "command_list", vectorcraft: "command_list", designcraft: "list_commands", figcraft: "list_commands", soundcraft: "list_commands" };
const dump: Record<string, any[]> = {};
for (const [s, tool] of Object.entries(lists)) {
  const r: any = await rt.callTool(s, tool, { args: {} });
  const text = r.content?.map((c: any) => c.text).join("") ?? "";
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  const arr: any[] = Array.isArray(data) ? data : data.commands ?? data.items ?? Object.values(data).find(Array.isArray) ?? [];
  dump[s] = arr;
  const ids = arr.map((c) => c.id ?? c.command ?? c.name);
  const free = ids.filter((id) => !craftCommandVerdict(id).ask);
  const risky = free.filter((id) => /(save|export|print|open|close|quit|import|load|place|link|url|share|send|publish|upload|download|delete|remove|clear|purge|reset|preset|pref|setting|script|plugin|run|exec|bounce|render|record|install|define|library|font|sync|backup|revert|package)/i.test(id));
  console.log(`## ${s}: ${ids.length} ids, ${free.length} free, sample ${ids.slice(0, 4).join(" ")}\nFREE+RISKY: ${risky.join(" ")}\n`);
}
mkdirSync(new URL("../.state/", import.meta.url), { recursive: true, mode: 0o700 });
writeFileSync(new URL("../.state/craft-commands.json", import.meta.url), JSON.stringify(dump));
await rt.close(); process.exit(0);
