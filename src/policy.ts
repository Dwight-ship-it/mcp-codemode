import { readFileSync } from "node:fs";
// Read/write rules: in-memory, undoable edits run
// freely; anything that leaves the app or can't be undone asks first: save, export,
// send, post, deploy, delete, buy, shell or JS execution. Unknown means ask.

export type Verdict = { ask: false } | { ask: true; reason: string };
export type Access = "read" | "write" | "depends";

export interface ServerPolicy {
  /** Static access label shown in the types. */
  access(tool: string): Access;
  /** Decide for one concrete call. */
  check(tool: string, args: Record<string, any>): Verdict;
  /** Tools whose results contain outside content (mail, logs, web pages, user text). */
  untrusted?(tool: string): boolean;
}

const FREE: Verdict = { ask: false };
const ask = (reason: string): Verdict => ({ ask: true, reason });

// Generic fallback: name prefixes are hints only; everything else asks.
// fetch, query, render and similar are left out: they can reach the network, run SQL or write files.
const READ_PREFIX = /^(get|list|search|find|inspect|read|describe|count|lookup|status)(_|-|$)/i;
export const genericPolicy: ServerPolicy = {
  access: (t) => (READ_PREFIX.test(t) ? "read" : "write"),
  check: (t) => (READ_PREFIX.test(t) ? FREE : ask(`${t} is not known to be read-only`)),
  untrusted: () => true, // nothing is known about this server, so its output counts as outside content
};

// ---------- Craft apps (PhotoCraft, PdfCraft, VectorCraft, DesignCraft, FigCraft, SoundCraft) ----------
// Their command runners take a menu command id. Ids were reviewed per app on 2026-11-23
// (photocraft 1,005, pdfcraft 194, vectorcraft 792, designcraft 521, soundcraft 478, figcraft 569).

// File-menu commands that stay inside the app (open, new, read a file into the document).
const CRAFT_FILE_FREE = new Set([
  "file.new", "file.newFromClipboard", "file.newSample", "file.fileInfo", "file.get_info", "file.open", "file.openAs", "file.openAsSmartObject",
  "file.placeEmbedded", "file.placeLinked", "file.export.presets.list", "file.export.presets.get", "file.presets",
  "file.printers", "file.print.printers", "file.import_audio", "file.import_midi", "file.import_video",
]);
// Leaves the app, persists app-wide state, or can't be undone.
const CRAFT_COMMAND_ASK =
  /(^|\.)(save\w*|saveACopy|saveContents|export\w*|print\w*|package|revealInFinder|quit|share|send_to\w*)(\.|$)|presets\.(save|delete|deleteGroup)|^plugin\.(install|remove|run|reload)|^actions\.(save|load|play|record|delete|newSet|assignSet)|^edit\.(preferences|presets)|^prefs\.|^help\.|^updates\.|^history\.delete|[Dd]roplet|^swatches\.(delete|deleteGroup|export)|^pattern\.(delete|export)|^brush\.presets|^document\.presets|^type\.saveDefault|^measurementLog\.(export|delete)|^file\.scripts\.(browse|scriptEventsManager)/;
// Can't be undone, or changes app-wide settings, libraries, linked files or the outside world.
const CRAFT_COMMAND_ASK_2 = new RegExp([
  /^history\.clear$|^edit\.purge\.|^edit\.colorSettings$|^edit\.define(BrushPreset|CustomShape|Pattern)$|^brush\.defineFromSelection$/.source,
  /presets?\.(new|edit|reset|delete|import\w*)$|^(swatches|pattern|gradient|style)\.(reset|import\w*|rename|renameGroup)$|^style\.presets\.import|^layer\.layerStyle\.contours\.(load|delete)$/.source,
  /[Cc]learHistory|preferences$|^setup\.|^app\.(?!links$|info$)|^script\.|^plugin\.(?!list$|info$)|^engine\.\w*plugins|retrospective_record/.source,
  /^library\.(?!list$|get$|json$|use$|setCurrent$|place$)|\.library\.(add|load|copyToUser)|^graphicStyle\.(saveLibrary|loadLibrary)$|^swatch\.resetDefaults$/.source,
  /^links\.(relink|relinkFolder|update|updateChanged|embed|unembed|copyTo|findFiles)$|^story\.(updateLink|placeAndLink)$|^book\./.source,
  /^color\.(settings|loadProfile|removeProfile)$|^text\.(addFontFiles|rescanFonts)$|^font\.reload$/.source,
  /^session\.(open|close|revert)$|^transport\.record|bounce/.source,
].join("|"));
// Canonical ids only: lowercase first segment, dot-separated words (SoundCraft uses snake_case).
const CRAFT_ID_FORM = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
// Batch step ids that name a drawing tool instead of a menu command (VectorCraft).
const CRAFT_STEP_TOOLS = new Set(["draw_path", "draw_shape"]);

export function craftCommandVerdict(id: unknown): Verdict { return baseCraftVerdict(id); }
function baseCraftVerdict(id: unknown): Verdict {
  if (typeof id !== "string" || !id) return ask("command without an id");
  if (CRAFT_STEP_TOOLS.has(id)) return FREE;
  if (!CRAFT_ID_FORM.test(id)) return ask(`unusual command id ${JSON.stringify(id)}`);
  if (id === "select.saveSelection") return FREE; // in-document channel, undoable
  if (id.startsWith("file.") && !CRAFT_FILE_FREE.has(id)) return ask(`${id} touches files or closes documents`);
  if (CRAFT_COMMAND_ASK.test(id)) return ask(`${id} leaves the app or can't be undone`);
  if (CRAFT_COMMAND_ASK_2.test(id)) return ask(`${id} can't be undone or changes app-wide settings, libraries or linked files`);
  return FREE;
}

/** Steps of any Craft batch shape: steps[{id}], commands[{command}], calls[{command}], or DesignCraft's script lines. */
export function batchSteps(args: Record<string, any>): unknown[] | null {
  // Collect from every shape at once: a harmless decoy under one key must not hide a step under another.
  const out: unknown[] = [];
  let found = false;
  for (const key of ["steps", "commands", "calls"]) {
    if (args?.[key] === undefined) continue;
    found = true;
    if (!Array.isArray(args[key])) { out.push(undefined); continue; } // unexpected shape: asks
    for (const s of args[key]) out.push(...commandIds(s));
  }
  if (args?.script !== undefined) {
    found = true;
    if (typeof args.script !== "string") out.push(undefined);
    else out.push(...args.script.split("\n").map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith("#") && !l.startsWith("//")).map((l: string) => l.split(/\s+/)[0]));
  }
  return found ? out : null;
}

/** Every command id a call names, under either key. Missing gives [undefined], which asks. */
function commandIds(o: any): unknown[] {
  const ids = ["id", "command"].filter((k) => o?.[k] !== undefined).map((k) => o[k]);
  return ids.length ? ids : [undefined];
}

/** The first verdict that asks, or free when all are. */
const strictest = (ids: unknown[], verdict: (id: unknown) => Verdict): Verdict => ids.map(verdict).find((v) => v.ask) ?? FREE;

function craftPolicy(opts: { read: string[]; free: string[]; command: string[]; batch: string[]; verdict?: (id: unknown) => Verdict; untrusted?: (tool: string) => boolean }): ServerPolicy {
  const read = new Set(opts.read), free = new Set(opts.free), command = new Set(opts.command), batch = new Set(opts.batch);
  const craftCommandVerdict = opts.verdict ?? baseCraftVerdict;
  return {
    access(t) {
      if (read.has(t) || free.has(t)) return "read";
      if (command.has(t) || batch.has(t) || t === "control_call") return "depends";
      return "write";
    },
    check(t, args) {
      if (read.has(t) || free.has(t)) return FREE;
      if (command.has(t)) return strictest(commandIds(args), craftCommandVerdict);
      if (batch.has(t)) {
        const steps = batchSteps(args);
        if (!steps || !steps.length) return ask("batch without steps");
        const asks = steps.map(craftCommandVerdict).filter((v) => v.ask) as { reason: string }[];
        return asks.length ? ask(`batch: ${asks.map((a) => a.reason).join("; ")}`) : FREE;
      }
      if (t === "control_call") {
        const m = String(args?.method ?? "");
        if (/(^|\.)(get|list|inspect|info|status|describe|ping|version|capabilities)$/i.test(m)) return FREE;
        if (m === "engine.execute") return strictest(commandIds(args?.params), craftCommandVerdict);
        return ask(`control_call ${m || "(no method)"}`);
      }
      return ask(`${t} saves, exports, closes, sends or drives the UI`);
    },
    untrusted: opts.untrusted,
  };
}

export const photocraftPolicy = craftPolicy({
  read: ["command_list", "doc_inspect", "doc_render_preview", "render_preview", "jobs_list", "session_list", "ui_inspect", "ui_screenshot"],
  free: ["doc_new", "doc_open", "doc_select", "doc_place", "doc_replace_smart_object", "doc_import_data_sets", "jobs_cancel"],
  command: ["command_run"],
  batch: ["command_batch"],
  // Asks: doc_save, doc_export*, doc_close (drops unsaved work), ui_menu_invoke, ui_pointer, ui_set, control_call unless read-like.
});

// PdfCraft menu commands that match tools which ask (doc_protect, sign_document, redact_apply, js_run, doc_split,
// page_extract, doc_combine, doc_reduce, doc_optimize, action_run, ocr_recognize_files, pdfa_convert).
const PDFCRAFT_COMMAND_ASK = /^tools\.(js_console|document_js)$|^protect\.|^sign\.(digital|certify|certify_invisible)$|^redact\.(apply|sanitize)$|^page\.(extract|split|combine)$|^create\.multiple|^optimize\.|^actions\.|^ocr\.recognize_batch$|^standards\.|^ui\.dock\.reset$/;
export const pdfcraftPolicy = craftPolicy({
  untrusted: (t) => t !== "command_list", // PDFs usually come from someone else
  verdict: (id) => {
    const base = baseCraftVerdict(id);
    if (base.ask) return base;
    return PDFCRAFT_COMMAND_ASK.test(String(id)) ? ask(`${id} writes files, signs, changes protection, removes content for good or runs JavaScript`) : FREE;
  },
  read: ["doc_list", "doc_info", "doc_inspect", "page_render", "render_preview", "object_list", "text_extract", "text_find", "text_lines", "text_paragraphs", "text_fonts", "text_font_files",
    "bookmark_list", "form_fields", "form_actions", "form_detect_fields", "doc_hidden_info", "doc_audit_redactions", "doc_audit_space", "printers", "printer_options", "content_list", "link_list",
    "measure_info", "measure_list", "comment_list", "comment_image_preview", "comments_summarize", "sign_list", "sign_windows_ids", "sign_keychain_ids", "accessibility_check", "accessibility_report",
    "accessibility_tags", "accessibility_figures", "accessibility_autotag_preview", "js_document_scripts", "js_enabled", "pdfa_verify", "print_readiness", "action_list", "doc_compare",
    "doc_compare_report", "ocr_status", "image_hit", "page_images", "doc_revisions", "command_list"],
  // In-memory and undoable until doc_save (per PdfCraft's own instructions), or opening/reading into a document.
  free: ["doc_open", "doc_create", "doc_open_revision", "page_rotate", "page_enhance_camera", "page_delete", "page_move", "page_insert_blank", "page_insert_file", "page_replace", "page_duplicate",
    "page_set_box", "page_number", "page_add_text", "page_add_image", "object_move", "bookmark_add", "bookmark_rename", "bookmark_delete", "bookmark_move", "bookmark_set_page", "bookmark_from_structure",
    "form_fill", "form_reset", "form_add_field", "form_set_image", "form_set_props", "form_tab_order", "form_delete_field", "form_merge_data", "stamp_custom", "doc_import_data", "redact_mark", "redact_clear",
    "content_update", "content_delete", "link_add", "link_edit", "link_delete", "links_from_urls", "links_remove", "measure_distance", "measure_perimeter", "measure_area", "measure_scale", "measure_snap",
    "comment_add", "comment_reply", "comment_set_status", "comment_mark", "comment_lock", "comment_edit", "comment_delete", "comments_hide", "view_reading_colors", "doc_header_footer", "doc_watermark",
    "doc_background", "doc_remove_marks", "doc_compare_mark", "accessibility_autotag_apply", "accessibility_fix", "accessibility_set_alt", "accessibility_set_tag_property", "accessibility_move_tag",
    "accessibility_review_record", "accessibility_review_load", "doc_initial_view", "doc_set_info", "text_edit", "text_edit_layout", "image_edit", "doc_flatten", "edit_undo", "edit_redo", "fill_sign_add",
    "fill_sign_date_format", "ocr_recognize", "text_font_import"],
  command: ["command_run"],
  batch: ["command_batch"],
  // Asks: doc_save, doc_close, doc_print, link_open, js_*, form_set_script, form_set_actions, sign_document/sign_id_create/sign_trust, doc_export_*, image_save,
  // doc_split/combine/create_multiple, page_extract, measure_export, accessibility_review_save/html, ocr_recognize_files, doc_reduce/optimize, pdfa_convert,
  // action_run, doc_protect/unprotect, redact_apply, doc_remove_hidden, doc_batch (writes to out_dir).
});

export const vectorcraftPolicy = craftPolicy({
  read: ["command_list", "list_commands", "doc_inspect", "inspect_document", "render_preview", "ui_inspect", "ui_screenshot", "inspect_ui", "screenshot"],
  free: ["open_file", "select_tool", "pointer_gesture", "draw_path", "draw_shape", "set_paint", "add_text", "type_text", "apply_effect", "pathfinder", "transform", "create_graph", "text_wrap", "undo", "redo", "open_panel"],
  command: ["command_run", "run_command"],
  batch: ["command_batch"],
  // Asks: save_file, export, invoke_menu, press_key (shortcuts can save or quit).
});

export const designcraftPolicy = craftPolicy({
  read: ["list_commands", "inspect_document", "get_story", "render_page", "screenshot", "menu_list", "ui_inspect"],
  free: ["new_document", "open_document", "set_story_text", "place_image", "select_tool", "pointer", "type_text", "ime", "dialog_set", "dialog_cancel"],
  command: ["execute"],
  batch: ["batch"],
  // Asks: save_document, export_png, key, click, drag, ui_set, dialog_confirm (could confirm a save or replace).
});

// FigCraft has team and publishing commands (collab.*, libraries.publish, branch.merge, plugin directory),
// so it uses an exact allowlist: anything not in it, including commands added later, asks.
const FIGCRAFT_FREE = new Set<string>(JSON.parse(readFileSync(new URL("../config/figcraft-free-commands.json", import.meta.url), "utf8")).free);
export const figcraftPolicy = craftPolicy({
  read: ["list_commands", "inspect_document", "get_node", "screenshot", "inspect_ui"],
  free: ["create_node", "set_properties", "select", "undo", "redo", "open_file", "pointer", "type_text"],
  command: ["run_command"],
  batch: ["batch"],
  verdict: (id) => (typeof id === "string" && FIGCRAFT_FREE.has(id) ? FREE : ask(`${String(id)} is not on FigCraft's reviewed list of in-document commands`)),
  // Asks: export, save_file, key.
});

export const soundcraftPolicy = craftPolicy({
  read: ["list_commands", "inspect_session", "screenshot", "ui_inspect"],
  free: ["new_session", "import_audio"],
  command: ["execute"],
  batch: ["batch"],
  // Asks: open_session (replaces the session), save_session, bounce_mix, parity, ui_set, menu_invoke, click, drag, key.
});

// ---------- Other local apps ----------

function listPolicy(opts: { read: string[]; free?: string[]; untrusted?: string[] | RegExp; why: string }): ServerPolicy {
  const read = new Set(opts.read), free = new Set(opts.free ?? []);
  const u = opts.untrusted;
  return {
    access: (t) => (read.has(t) || free.has(t) ? "read" : "write"),
    check: (t) => (read.has(t) || free.has(t) ? FREE : ask(`${t} ${opts.why}`)),
    untrusted: (t) => (u instanceof RegExp ? u.test(t) : !!u?.includes(t)),
  };
}

export const alfredPolicy = listPolicy({ read: ["alfred_list_workflows", "alfred_get_workflow"], why: "changes, exports or runs Alfred workflows" });
// llm_critique uploads audio to Gemini; sfx_render and kit_render write files.
export const earshotPolicy = listPolicy({ read: ["measure", "describe", "match", "rank", "find", "compare", "ab", "realness", "timeline", "sheet", "critique", "doctor", "sfx_list"], why: "uploads audio or writes files" });

// REA: static analysis and in-project annotations run freely; anything that runs code, starts or
// attaches to processes, touches devices, the network or writes files asks. All output is target content.
const REA_FREE = /^(inspect_(?!web_page$)\w+|list_\w+|get_\w+|search_\w+|analyze_\w+|batch_decompile|decompile_jeb_item|procedure_\w+|read_(bytes|function_instructions|adb_logcat|adb_setting)|xrefs|find_\w+|compare_\w+|demangle_swift|decode_\w+|identify_\w+|verify_\w+|evaluate_\w+|build_\w+|project_\w+|correlate_static_and_runtime|current_\w+|address_\w+|next_address|prev_address|goto_address|resolve_\w+|trace_(android_references|call_path|dylib_resolution|native_values|feature|application_feature|javascript_semantics|web_module_imports|web_source_location)|binary_overview|binary_session|open_binary|close_binary|open_jeb_project|\w+_session_status|reconcile_javascript_runtime|annotate_native_function|set_\w+|comment|inline_comment|unset_bookmark|record_unknown|update_unknown|import_evidence_bundle|import_managed_reconstruction|close_(frida|gdb|rizin_debug)_session|unload_frida_script)$/;
// Named like static analysis, but they talk to a device, a running app or a browser.
const REA_LIVE = /adb|electron_(page|targets)|browser_targets|runtime_targets|web_(page|event_listeners)|frida_(devices|processes)|verify_reconstruction/;
const reaFree = (t: string) => REA_FREE.test(t) && !REA_LIVE.test(t);
export const reaPolicy: ServerPolicy = {
  access: (t) => (reaFree(t) ? "read" : "write"),
  check: (t) => (reaFree(t) ? FREE : ask(`${t} runs code, drives a process or device, uses the network or writes files`)),
  untrusted: () => true,
};

// ---------- Vercel ----------

const VERCEL_READ = /^(get|list|search|count|aggregate|filter|read|git_namespaces|artifact_query|wait_for_board_changes)(_|-|$)/;
// Named like reads but create links, resources or access.
const VERCEL_READ_BUT_ASK = new Set([
  "get_access_to_vercel_url", "get_or_create_drive", "get_project_deletion_link",
  "get_flags_project_disconnection_link", "get_bypass_ip",
]);
// Reads that can return secrets: environment variables, tokens, SDK keys, drain and webhook settings, files.
const VERCEL_SECRET = /(^|_)(env|envs|token|tokens|secret|secrets|sdk_keys|drain|drains|webhooks)(_|$)|^read_session_file$/;
const VERCEL_FREE = (t: string) => VERCEL_READ.test(t) && !VERCEL_READ_BUT_ASK.has(t) && !VERCEL_SECRET.test(t) || t === "search_vercel_documentation";
const VERCEL_UNTRUSTED = /runtime_logs|runtime_errors|web_fetch_vercel_url|deployment_file_contents|deployment_events|toolbar|board|read_session_file|session_command_logs|ci_.*logs|trace/;

export const vercelPolicy: ServerPolicy = {
  access: (t) => (VERCEL_FREE(t) ? "read" : "write"),
  check(t) {
    if (VERCEL_READ_BUT_ASK.has(t)) return ask(`${t} creates a link or grants access`);
    if (VERCEL_SECRET.test(t)) return ask(`${t} can return secrets`);
    if (t === "web_fetch_vercel_url") return ask(`${t} sends a request to a URL and can create a share link`);
    if (VERCEL_FREE(t)) return FREE;
    return ask(`${t} changes your Vercel account`);
  },
  untrusted: (t) => VERCEL_UNTRUSTED.test(t),
};

const POLICIES: Record<string, ServerPolicy> = {
  photocraft: photocraftPolicy, pdfcraft: pdfcraftPolicy, vectorcraft: vectorcraftPolicy, designcraft: designcraftPolicy,
  figcraft: figcraftPolicy, soundcraft: soundcraftPolicy, rea: reaPolicy, earshot: earshotPolicy, alfred: alfredPolicy, vercel: vercelPolicy,
};
export const policyFor = (server: string): ServerPolicy => POLICIES[server] ?? genericPolicy;
