# mcp-codemode

A local gateway that puts all your MCP servers behind two tools, so an agent can write one script instead of making dozens of tool calls.

- **`search_tools`** finds functions across every server and returns their TypeScript types.
- **`run_code`** runs a JavaScript script that calls those functions, and returns only what the script returns.

Scripts run in a Deno sandbox with no network, file, environment or process access. They can only act through the gateway, which checks every call against a policy. Calls that save, send, deploy, delete or can return secrets pause for a macOS approval dialog.

> **This is a showcase, not a supported product.** It's a snapshot of a personal tool. It isn't maintained here, and issues and pull requests may go unanswered. Read the limits below before running it with anything you care about.

## How it works

```
agent ── search_tools / run_code ──▶ gateway (127.0.0.1, bearer token)
                                       │   ├─ catalog   MCP tools → TypeScript types
                                       │   ├─ policy    free, or ask first
                                       │   └─ approval  macOS dialog + audit log
                                       │
                 Deno, no permissions ◀┤  script runs here; calls go over stdin/stdout
                                       │
                                       └─ mcporter ──▶ your MCP servers (stdio or HTTP)
```

A script looks like this:

```js
const docs = await photocraft.command_list({ filter: "blur" });
return docs.slice(0, 5).map((d) => d.id);
```

| File | What it does |
|---|---|
| `src/gateway.ts` | MCP front end (HTTP or `--stdio`), script runs, results and images |
| `src/catalog.ts` | Loads servers through [mcporter](https://www.npmjs.com/package/mcporter), tool search |
| `src/typegen.ts` | JSON Schema to TypeScript declarations |
| `src/policy.ts` | Which calls run freely and which ask |
| `src/approval.ts` | The dialog and the audit log |
| `src/sandbox.ts`, `sandbox/runner.js` | The Deno process and its call protocol |
| `bench/` | Benchmark: direct MCP tools vs the gateway |

The per-server rules are examples for the servers it was built with: the Craft apps, REA, earshot, Alfred and Vercel. Any other server gets the generic rule, where only tools named like plain reads run freely.

## Does it save anything?

Sometimes. Five tasks in Claude Code (Sonnet, headless), comparing direct MCP tools with the gateway. Averages over all valid runs:

| Task | Runs (direct / gateway) | Turns | Cost | Input tokens |
|---|---|---|---|---|
| Domains across all Vercel projects | 2 / 5 | 32.5 → 7.6 | **−37%** | +7% |
| Run every blur and sharpen filter, check, undo | 1 / 1 | 18 → 7 | −12% | −43% |
| Deployments and errors for 5 projects | 2 / 4 | 14 → 7.2 | −4% | +26% |
| Build a layered image and look at it | 2 / 2 | 13.5 → 7 | 0% | −12% |
| One filtered lookup | 2 / 4 | 4 → 4.2 | +17% | +49% |

So it helps when a job takes many calls, and costs more for a single lookup. Claude Code already keeps tool definitions out of context with its own tool search, so there's less to save there than in a client that loads them all.

Treat these as rough: there are very few runs per task, search and output were tuned between gateway runs on these same tasks, and the numbers predate the security fixes in this snapshot. Writes were refused in both modes. Two direct runs were left out because their MCP server wasn't connected.

## Running it

macOS, Node 24+ and [Deno](https://deno.com) on your `PATH`.

```sh
npm install
cp config/mcporter.example.json config/mcporter.json   # then edit it
npm test
npm start                                              # http://127.0.0.1:7801/mcp
```

The bearer token is created in `.state/token` on first start. For servers that use OAuth, run `npm run auth -- <server>`. Add your own rules in `src/policy.ts`.

## Security model and limits

What it does:

- The sandbox gets no Deno permissions, and the tests try to break out through the network, files, environment, processes, imports and FFI.
- Each decision looks at every command id in a call, so a harmless decoy can't hide a real one.
- The dialog escapes invisible and text-direction characters, and says so when arguments are too long to show.
- After a script reads outside content, such as a PDF or logs, every later write in that client session asks again, with a warning.

What it doesn't do:

- **It doesn't protect against other programs running as you.** They can read the bearer token, mcporter's OAuth tokens (`~/.mcporter`) and the audit log, and they can click dialogs.
- **Reads that run freely still reach the model.** With a server that reads local files, a script can read whatever that server can.
- **Some rules go by tool name.** A new tool named like a read runs freely until someone reviews it. Server-supplied annotations aren't trusted.
- **Outside content is tracked per server and tool**, as listed in `src/policy.ts`, and only within one client session.
- **Descriptions and instructions from servers go to the model as they are.**
- **"Approve rest of script" means what it says:** later writes in that script run without showing their arguments, until outside content arrives.
- **The audit log stores arguments in plain text.** It's readable only by you.

## License

[MIT](LICENSE)
