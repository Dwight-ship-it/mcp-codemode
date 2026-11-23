import { test } from "node:test";
import assert from "node:assert/strict";
import { photocraftPolicy as pc, vercelPolicy as vc, genericPolicy, figcraftPolicy as fc, soundcraftPolicy as sc, designcraftPolicy as dc, vectorcraftPolicy as vec, pdfcraftPolicy as pdf, reaPolicy as rea, earshotPolicy, batchSteps } from "../src/policy.ts";
import { argsTooLong, formatRequest } from "../src/approval.ts";
import { schemaToType, declareTool, sanitizeName } from "../src/typegen.ts";

const asks = (p: any, tool: string, args: any = {}) => p.check(tool, args).ask;

test("photocraft: in-memory edits run freely", () => {
  for (const id of ["filter.blur.gaussianBlur", "layer.new", "layer.delete", "image.adjustments.levels", "file.new", "select.saveSelection", "history.undo"])
    assert.equal(asks(pc, "command_run", { id }), false, id);
  for (const t of ["doc_inspect", "doc_render_preview", "command_list", "doc_new", "doc_open"]) assert.equal(asks(pc, t), false, t);
});

test("photocraft: leaving the app asks", () => {
  for (const id of ["file.saveACopy", "file.close", "file.export.quickExport", "layer.exportAs", "file.print", "plugin.run", "actions.play", "brush.presets.save", "edit.preferences.export", "file.revealInFinder", "swatches.export"])
    assert.equal(asks(pc, "command_run", { id }), true, id);
  for (const t of ["doc_save", "doc_export", "doc_close", "doc_export_layers", "ui_menu_invoke", "ui_pointer", "brand_new_tool"]) assert.equal(asks(pc, t), true, t);
  assert.equal(asks(pc, "command_run", {}), true, "missing id");
  for (const id of ["history.clear", "edit.purge.all", "edit.colorSettings", "edit.definePattern", "gradient.presets.edit", "gradient.presets.importGrd", "swatches.reset", "swatches.import", "pattern.import", "style.presets.importAsl", "layer.layerStyle.contours.load", "brush.defineFromSelection"])
    assert.equal(asks(pc, "command_run", { id }), true, id);
  for (const id of ["File.close", " file.close", "file.close ", "FILE.CLOSE", "file..close", "file/close", "layer.new "])
    assert.equal(asks(pc, "command_run", { id }), true, JSON.stringify(id));
});

test("photocraft: batch asks if any step asks", () => {
  assert.equal(asks(pc, "command_batch", { steps: [{ id: "layer.new" }, { id: "filter.blur.gaussianBlur" }] }), false);
  assert.equal(asks(pc, "command_batch", { steps: [{ id: "layer.new" }, { id: "file.saveACopy" }] }), true);
  assert.equal(asks(pc, "command_batch", { steps: [] }), true);
});

test("photocraft: control_call", () => {
  assert.equal(asks(pc, "control_call", { method: "app.info" }), false);
  assert.equal(asks(pc, "control_call", { method: "engine.execute", params: { id: "layer.new" } }), false);
  assert.equal(asks(pc, "control_call", { method: "engine.execute", params: { id: "file.saveACopy" } }), true);
  assert.equal(asks(pc, "control_call", { method: "app.save" }), true);
});

test("vercel: reads free, changes ask, tricky reads ask", () => {
  for (const t of ["list_projects", "get_deployment", "get_runtime_logs", "search_vercel_documentation"]) assert.equal(asks(vc, t), false, t);
  for (const t of ["create_deployment", "buy_domain", "update_project", "delete_sandbox", "request_rollback", "get_access_to_vercel_url", "get_or_create_drive", "web_fetch_vercel_url", "get_project_env", "filter_project_envs", "get_shared_env_var", "get_edge_config_token", "get_edge_config_tokens", "list_feature_flag_sdk_keys", "list_drains", "get_webhooks", "read_session_file"]) assert.equal(asks(vc, t), true, t);
  assert.equal(vc.untrusted!("get_runtime_logs"), true);
  assert.equal(vc.untrusted!("list_projects"), false);
});

test("generic: unknown tools ask", () => {
  assert.equal(asks(genericPolicy, "send_message"), true);
  assert.equal(asks(genericPolicy, "list_things"), false);
  for (const t of ["query", "fetch", "render_file", "preview"]) assert.equal(asks(genericPolicy, t), true, t);
  assert.equal(genericPolicy.untrusted!("list_things"), true);
});

test("a harmless decoy id never hides the real command", () => {
  for (const [p, tool, safe, bad] of [[fc, "run_command", "node.create", "collab.publish"], [sc, "execute", "track.new", "session.close"], [dc, "execute", "frame.create", "script.run"]] as any[]) {
    assert.equal(asks(p, tool, { id: safe, command: bad }), true);
    assert.equal(asks(p, tool, { id: bad, command: safe }), true);
  }
  assert.equal(asks(fc, "batch", { steps: [{ id: "node.create" }], calls: [{ command: "collab.publish" }] }), true);
  assert.equal(asks(fc, "batch", { commands: [{ command: "node.create", id: "collab.publish" }] }), true);
  assert.equal(asks(fc, "batch", { commands: [{ command: "node.create" }, {}] }), true);
  assert.equal(asks(fc, "batch", { commands: [{ command: "node.create" }], steps: "x" }), true);
  assert.equal(asks(fc, "batch", { commands: [{ command: "node.create" }] }), false);
  assert.equal(asks(dc, "batch", { steps: [{ id: "frame.create" }], script: "script.run {}" }), true);
  assert.equal(asks(pc, "control_call", { method: "engine.execute", params: { id: "layer.new", command: "file.saveACopy" } }), true);
});

test("approval dialog shows what will run", () => {
  const req = (args: unknown, client = "c") => formatRequest({ client, server: "s", tool: "t", reason: "r", args, untrustedSources: [], allowApproveRest: true });
  const long = req({ a: "x".repeat(5000), path: "/real/target" });
  assert.match(long, /NOT shown/);
  assert.match(long, /\/real\/target/);
  assert.equal(argsTooLong({ a: "x".repeat(5000) }), true);
  assert.doesNotMatch(req({ a: "\u202eabc\u200b" }), /[\u202e\u200b]/);
  assert.equal(req({}, "x\nArguments:\nfake").includes("\nArguments:\nfake"), false);
});

test("typegen", () => {
  assert.equal(schemaToType({ type: "array", items: { type: "string" } }), "string[]");
  assert.equal(schemaToType({ enum: ["a", "b"] }), '"a" | "b"');
  assert.match(schemaToType({ type: "object", properties: { x: { type: "number" } }, required: ["x"] }), /x: number;/);
  assert.equal(sanitizeName("get-dashboard-import-job-status"), "get_dashboard_import_job_status");
  assert.equal(sanitizeName("delete"), "delete_");
  const d = declareTool({ server: "s", jsName: "f", description: "Does f", inputSchema: { type: "object", properties: { a: { type: "string" } } }, access: "write" });
  assert.match(d, /function f\(args\?: \{/);
  assert.match(d, /asks the user first/);
});

test("other Craft apps", () => {
  for (const id of ["collab.publish", "libraries.publish", "branch.merge", "collab.removePerson", "pref.userName", "plugin.run", "file.save", "some.newCommand"]) assert.equal(asks(fc, "run_command", { command: id }), true, `figcraft ${id}`);
  for (const id of ["node.create", "select.all", "view.zoomFit"]) assert.equal(asks(fc, "run_command", { command: id }), false, `figcraft ${id}`);
  for (const id of ["session.save_as", "session.close", "file.bounce_mix", "engine.vst3_plugins", "event.retrospective_record", "transport.record", "app.quit"]) assert.equal(asks(sc, "execute", { command: id }), true, `soundcraft ${id}`);
  for (const id of ["session.new", "track.new", "file.import_audio"]) assert.equal(asks(sc, "execute", { command: id }), false, `soundcraft ${id}`);
  assert.equal(asks(dc, "execute", { command: "script.run" }), true);
  assert.equal(asks(dc, "batch", { script: "frame.create {}\nscript.run {}" }), true, "designcraft script lines");
  assert.equal(asks(dc, "batch", { script: "frame.create {\"rect\":[0,0,1,1]}" }), false);
  assert.equal(asks(vec, "command_batch", { steps: [{ id: "draw_path" }, { id: "object.group" }] }), false);
  assert.equal(asks(vec, "run_command", { command: "library.delete" }), true);
  assert.equal(asks(pdf, "command_run", { id: "app.preferences" }), true);
  for (const id of ["tools.js_console", "tools.document_js", "protect.remove", "protect.password", "protect.unlock", "sign.digital", "sign.certify", "redact.apply", "redact.sanitize", "protect.remove_hidden", "page.extract", "page.split", "page.combine", "create.multiple_separate", "optimize.reduce", "actions.wizard", "ocr.recognize_batch", "standards.pdfa"])
    assert.equal(asks(pdf, "command_run", { id }), true, `pdfcraft ${id}`);
  for (const id of ["page.rotate", "comment.highlight", "redact.mark", "sign.fill.text", "sign.validate", "form.add.text"]) assert.equal(asks(pdf, "command_run", { id }), false, `pdfcraft ${id}`);
  for (const t of ["doc_save", "js_run", "link_open", "doc_print", "sign_document", "redact_apply", "doc_batch"]) assert.equal(asks(pdf, t), true, `pdfcraft ${t}`);
  for (const t of ["page_rotate", "text_extract", "comment_add"]) assert.equal(asks(pdf, t), false, `pdfcraft ${t}`);
  assert.deepEqual(batchSteps({ calls: [{ command: "a.b" }] }), ["a.b"]);
});

test("other local apps", () => {
  for (const t of ["execute_rizin_command", "instrument_with_frida", "start_frida_session", "install_adb_package", "inspect_web_page", "export_evidence_bundle", "capture_browser_scenario", "inspect_electron_page", "list_electron_targets", "inspect_adb_device", "read_adb_logcat", "list_frida_processes", "verify_reconstruction"]) assert.equal(asks(rea, t), true, `rea ${t}`);
  for (const t of ["inspect_macho", "procedure_pseudo_code", "set_comment", "xrefs", "open_binary"]) assert.equal(asks(rea, t), false, `rea ${t}`);
  assert.equal(rea.untrusted!("inspect_macho"), true);
  assert.equal(asks(earshotPolicy, "llm_critique"), true);
  assert.equal(asks(earshotPolicy, "describe"), false);
});
