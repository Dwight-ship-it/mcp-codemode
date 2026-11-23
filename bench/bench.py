#!/usr/bin/env python3
"""Run the same tasks in Claude Code headless: direct MCP tools vs the Code Mode gateway.
Usage: bench.py <mode: direct|gateway> <task ids...> [--model sonnet] [--port 7803]"""
import json, os, subprocess, sys, time, pathlib, tempfile
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
args = sys.argv[1:]
model = "sonnet"; port = "7803"
if "--model" in args: i = args.index("--model"); model = args[i+1]; del args[i:i+2]
if "--port" in args: i = args.index("--port"); port = args[i+1]; del args[i:i+2]
mode, task_ids = args[0], args[1:]
tasks = json.load(open(HERE / "tasks.json"))
cfg = json.load(open(ROOT / "config" / "mcporter.json"))["mcpServers"]
token = (ROOT / ".state" / "token").read_text().strip()
out_dir = ROOT / ".state" / "bench"; out_dir.mkdir(parents=True, exist_ok=True)
NO_LOCAL = ["Bash", "Edit", "Write", "Read", "Glob", "Grep", "WebFetch", "WebSearch", "Agent", "NotebookEdit", "Skill", "Workflow", "Artifact"]
PREFIX = "Proceed directly, no clarifying questions. Use only the MCP tools you have. Task: "

for tid in task_ids:
    t = tasks[tid]
    env = dict(os.environ)
    if mode == "gateway":
        servers = {"codemode": {"type": "http", "url": f"http://127.0.0.1:{port}/mcp", "headers": {"Authorization": f"Bearer {token}"}}}
        env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false"
    elif t["needs"] == "photocraft":
        p = cfg["photocraft"]; servers = {"photocraft": {"command": p["command"], "args": p["args"]}}
        env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false"
    else:
        # Headless Claude Code doesn't load claude.ai connectors, so serve the same tools 1:1.
        servers = {t["needs"]: {"command": "node", "args": [str(HERE / "direct-proxy.ts"), t["needs"]]}}
        env["ENABLE_CLAUDEAI_MCP_SERVERS"] = "false"
    mcp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, dir=out_dir)
    json.dump({"mcpServers": servers}, mcp); mcp.close()
    cmd = ["claude", "-p", PREFIX + t["prompt"], "--model", model, "--output-format", "stream-json", "--verbose",
           "--mcp-config", mcp.name, "--strict-mcp-config", "--dangerously-skip-permissions", "--no-session-persistence",
           "--disallowedTools", *NO_LOCAL]
    work = tempfile.mkdtemp(prefix="bench-")
    t0 = time.time()
    p = subprocess.run(cmd, cwd=work, env=env, capture_output=True, text=True, timeout=900)
    dur = time.time() - t0
    os.unlink(mcp.name)
    events = [json.loads(l) for l in p.stdout.splitlines() if l.strip().startswith("{")]
    init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), {})
    res = next((e for e in reversed(events) if e.get("type") == "result"), {})
    u = res.get("usage", {})
    tool_uses = [b.get("name") for e in events if e.get("type") == "assistant" for b in e.get("message", {}).get("content", []) if b.get("type") == "tool_use"]
    rec = {
        "task": tid, "mode": mode, "model": model, "at": time.strftime("%Y-%m-%d %H:%M"),
        "input_tokens": u.get("input_tokens", 0), "cache_creation": u.get("cache_creation_input_tokens", 0),
        "cache_read": u.get("cache_read_input_tokens", 0), "output_tokens": u.get("output_tokens", 0),
        "total_in": u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0),
        "turns": res.get("num_turns"), "cost_usd": res.get("total_cost_usd"), "seconds": round(dur),
        "tool_calls": len(tool_uses), "tools_used": tool_uses,
        "mcp_servers": [s.get("name") + ":" + s.get("status", "") for s in init.get("mcp_servers", [])],
        "result": res.get("result", "")[:4000], "is_error": res.get("is_error"), "stderr": p.stderr[-800:],
    }
    with open(out_dir / "results.jsonl", "a") as f: f.write(json.dumps(rec) + "\n")
    print(json.dumps({k: rec[k] for k in ["task", "mode", "total_in", "output_tokens", "turns", "tool_calls", "cost_usd", "seconds", "mcp_servers", "is_error"]}))
