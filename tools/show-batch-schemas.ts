import { createRuntime } from "mcporter";
const rt = await createRuntime({ configPath: new URL("../config/mcporter.json", import.meta.url).pathname });
const want: Record<string, string[]> = { pdfcraft: ["command_run", "command_batch", "doc_batch"], vectorcraft: ["command_run", "run_command", "command_batch"], designcraft: ["execute", "batch"], figcraft: ["run_command", "batch"], soundcraft: ["execute", "batch"] };
for (const [s, tools] of Object.entries(want)) {
  const all = await rt.listTools(s, { includeSchema: true, disableOAuth: true });
  for (const t of all.filter((x) => tools.includes(x.name))) console.log(s, t.name, JSON.stringify(t.inputSchema).slice(0, 420));
}
await rt.close(); process.exit(0);
