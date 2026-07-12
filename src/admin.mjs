import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readRuntimeSettings, writeRuntimeSettings } from "./runtime-settings.mjs";

const MAX_BODY_BYTES = 20 * 1024;
const ROSETTA_SEND_SCRIPT = 'for p in /proc/[0-9]*; do cmd=$(tr "\\000" " " < "$p/cmdline" 2>/dev/null) || continue; case "$cmd" in ./bedrock_server-*) printf "%s\\n" "$1" > "$p/fd/0"; exit $?;; esac; done; echo "ERROR: Bedrock process not found" >&2; exit 2';

function send(response, status, body, type = "application/json; charset=utf-8") {
  const value = type.startsWith("application/json") ? JSON.stringify(body) : body;
  response.writeHead(status, {
    "content-type": type,
    "content-length": Buffer.byteLength(value),
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  response.end(value);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("request body must be valid JSON"), { status: 400 });
  }
}

export function validateConsoleCommand(value) {
  const command = typeof value === "string" ? value.trim() : "";
  if (!command || command.length > 500 || /[\r\n\0]/.test(command)) {
    throw Object.assign(new Error("command must be one line with 1-500 characters"), { status: 400 });
  }
  return command.replace(/^\//, "");
}

function run(command, args, timeout = 8_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const output = [];
    const collect = (chunk) => {
      if (output.reduce((size, item) => size + item.length, 0) < 128 * 1024) output.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: error.message });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: Buffer.concat(output).toString("utf8").trim() });
    });
  });
}

async function probe(url, fetchImpl) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_000) });
    return response.ok ? await response.json() : { ok: false };
  } catch {
    return { ok: false };
  }
}

async function sendBedrockCommand(execute, command) {
  let result = await execute("container", ["exec", "mc-wizard-bedrock", "send-command", command]);
  if (result.code !== 0 && /unable to find bedrock server process/i.test(result.output)) {
    result = await execute("container", ["exec", "mc-wizard-bedrock", "sh", "-c", ROSETTA_SEND_SCRIPT, "mc-wizard", command]);
  }
  return result;
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MC Wizard Operator Desk</title>
<style>
:root{color-scheme:light dark;--bg:#ece8dd;--panel:#f8f4e9;--ink:#24271f;--muted:#686b60;--line:#c9c4b5;--accent:#355f4b;--accentText:#f7f2e6;--danger:#8b3a36;--shadow:0 10px 30px rgba(44,45,35,.09)}
@media(prefers-color-scheme:dark){:root{--bg:#1d211c;--panel:#282d27;--ink:#edf0e7;--muted:#adb3a6;--line:#444b40;--accent:#91b79d;--accentText:#182019;--danger:#e18d85;--shadow:0 12px 34px rgba(0,0,0,.22)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}button,input,textarea,select{font:inherit;color:inherit}button{cursor:pointer}.shell{max-width:1220px;margin:auto;padding:28px}.top{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:24px}.top h1{font:700 clamp(28px,5vw,52px)/.95 Georgia,serif;margin:0;letter-spacing:-.035em}.top p{color:var(--muted);margin:9px 0 0}.health{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.badge{border:1px solid var(--line);padding:7px 10px;border-radius:999px;background:var(--panel)}.badge[data-ok=true]::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:#4e9b67;margin-right:7px}.badge[data-ok=false]::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--danger);margin-right:7px}.grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1.45fr);gap:18px;align-items:start}.stack{display:grid;gap:18px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:20px;box-shadow:var(--shadow)}.panel h2{font:700 21px/1.1 Georgia,serif;margin:0 0 6px}.panel .help{color:var(--muted);margin:0 0 16px;font-size:13px}.actions{display:flex;flex-wrap:wrap;gap:8px}.button{border:1px solid var(--line);background:transparent;border-radius:9px;padding:9px 12px}.button:hover,.button:focus-visible{border-color:var(--accent);outline:none;transform:translateY(-1px)}.primary{background:var(--accent);color:var(--accentText);border-color:var(--accent)}.danger{color:var(--danger)}label{display:grid;gap:6px;margin-top:14px;font-weight:700;font-size:13px}input,textarea,select{width:100%;border:1px solid var(--line);border-radius:10px;background:var(--bg);padding:10px 11px}textarea{min-height:125px;resize:vertical;line-height:1.5}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.check{display:flex;align-items:center;gap:9px}.check input{width:auto}.console{display:grid;grid-template-columns:1fr auto;gap:8px}.result,pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px;max-height:360px;overflow:auto}.result:empty{display:none}pre{margin:0;font-size:12px}.saved{color:var(--accent);min-height:22px;margin-top:10px}.footer{color:var(--muted);font-size:12px;margin:18px 2px 0}.subtle{font-size:12px;color:var(--muted)}
@media(max-width:780px){.shell{padding:18px}.top{align-items:start;flex-direction:column}.health{justify-content:flex-start}.grid,.row{grid-template-columns:1fr}.panel{border-radius:14px;padding:17px}.console{grid-template-columns:1fr}}
@media(prefers-reduced-motion:no-preference){.button{transition:transform .15s ease,border-color .15s ease}}
</style>
</head>
<body>
<main class="shell">
  <header class="top"><div><h1>MC Wizard<br>operator desk</h1><p>Live controls for the local family server.</p></div><div class="health"><span class="badge" id="bedrock">Bedrock</span><span class="badge" id="brain">Brain</span><span class="badge" id="provider">Provider</span></div></header>
  <div class="grid">
    <div class="stack">
      <section class="panel"><h2>World controls</h2><p class="help">These commands run immediately in the Bedrock console.</p><div class="actions">
        <button class="button quick" data-command="time set day">Set day</button><button class="button quick" data-command="weather clear">Clear weather</button><button class="button quick" data-command="gamerule doDaylightCycle false">Pause daylight</button><button class="button quick" data-command="gamerule doDaylightCycle true">Resume daylight</button><button class="button quick" data-command="list">List players</button>
      </div><label for="command">Console command</label><div class="console"><input id="command" placeholder="say Welcome, builders"><button class="button primary" id="send">Send</button></div><div class="saved" id="consoleStatus"></div></section>
      <section class="panel"><h2>Test the brain</h2><p class="help">Ask without joining Minecraft. This uses a separate admin session.</p><label>Mode<select id="mode"><option value="wizard">MC Wizard</option><option value="general">General AI</option></select></label><label>Message<textarea id="question" placeholder="Build a small redstone memory switch and explain it."></textarea></label><div class="actions"><button class="button primary" id="ask">Ask</button><button class="button" id="clearSession">Clear test session</button></div><div class="result" id="answer"></div></section>
    </div>
    <div class="stack">
      <section class="panel"><h2>AI tuning</h2><p class="help">Saved changes apply to the next AI request. Bedrock does not restart. Core safety and action contracts remain active.</p><label class="check"><input type="checkbox" id="aiEnabled">Use the configured AI provider</label><label>MC Wizard prompt addendum<textarea id="wizardPrompt" placeholder="Example: Keep replies under four sentences unless the player asks for a lesson."></textarea></label><label>General AI prompt addendum<textarea id="generalPrompt" placeholder="Example: Use short section headings for long guides."></textarea></label><div class="row"><label>Wizard max output tokens<input id="wizardTokens" type="number" min="64" max="3000" placeholder="Use environment default"></label><label>General max output tokens<input id="generalTokens" type="number" min="64" max="3000" placeholder="Use environment default"></label></div><div class="actions" style="margin-top:16px"><button class="button primary" id="save">Save live tuning</button><button class="button" id="reload">Discard edits</button></div><div class="saved" id="saveStatus"></div></section>
      <section class="panel"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><div><h2>Recent server log</h2><p class="help">Console replies and player activity appear here.</p></div><button class="button" id="refreshLogs">Refresh</button></div><pre id="logs">Loading...</pre></section>
    </div>
  </div>
  <p class="footer">Loopback only: this desk is available on this Mac, not to players on the LAN.</p>
</main>
<script>
const $=id=>document.getElementById(id);async function api(path,options={}){const response=await fetch(path,{headers:{"content-type":"application/json"},...options});const value=await response.json();if(!response.ok)throw new Error(value.error||"Request failed");return value}
async function status(){const value=await api("/api/status");for(const key of ["bedrock","brain","provider"]){$(key).dataset.ok=String(Boolean(value[key]));}$("provider").textContent=value.providerName||"Provider"}
async function loadSettings(){const value=await api("/api/settings");$("aiEnabled").checked=value.aiEnabled;$("wizardPrompt").value=value.wizardPromptAddendum;$("generalPrompt").value=value.generalPromptAddendum;$("wizardTokens").value=value.wizardMaxOutputTokens??"";$("generalTokens").value=value.generalMaxOutputTokens??"";$("saveStatus").textContent=""}
async function saveSettings(){try{await api("/api/settings",{method:"PUT",body:JSON.stringify({aiEnabled:$("aiEnabled").checked,wizardPromptAddendum:$("wizardPrompt").value,generalPromptAddendum:$("generalPrompt").value,wizardMaxOutputTokens:$("wizardTokens").value||null,generalMaxOutputTokens:$("generalTokens").value||null})});$("saveStatus").textContent="Saved. The next AI request will use this tuning."}catch(error){$("saveStatus").textContent=error.message}}
async function sendCommand(command,confirmFirst=true){if(confirmFirst&&!window.confirm('Run "'+command+'" on the Bedrock server?'))return;$("consoleStatus").textContent="Sending...";try{await api("/api/console",{method:"POST",body:JSON.stringify({command})});$("consoleStatus").textContent='Sent: '+command;setTimeout(loadLogs,600)}catch(error){$("consoleStatus").textContent=error.message}}
async function ask(){$("answer").textContent="Thinking...";try{const value=await api("/api/ask",{method:"POST",body:JSON.stringify({question:$("question").value,mode:$("mode").value})});$("answer").textContent=value.answer+(value.action?'\\n\\nAction: '+JSON.stringify(value.action):'')+(value.title?'\\n\\nBook title: '+value.title:'')}catch(error){$("answer").textContent=error.message}}
let logsLoading=false;async function loadLogs(){if(logsLoading)return;logsLoading=true;try{const panel=$("logs");panel.textContent=(await api("/api/logs")).logs||"No log output yet.";requestAnimationFrame(()=>{panel.scrollTop=panel.scrollHeight})}catch(error){$("logs").textContent=error.message}finally{logsLoading=false}}
document.querySelectorAll(".quick").forEach(button=>button.onclick=()=>sendCommand(button.dataset.command,false));$("send").onclick=()=>sendCommand($("command").value);$("command").onkeydown=event=>{if(event.key==="Enter")sendCommand($("command").value)};$("save").onclick=saveSettings;$("reload").onclick=loadSettings;$("ask").onclick=ask;$("clearSession").onclick=async()=>{await api("/api/session",{method:"DELETE",body:JSON.stringify({mode:$("mode").value})});$("answer").textContent="Test session cleared."};$("refreshLogs").onclick=loadLogs;
Promise.all([status(),loadSettings(),loadLogs()]);setInterval(status,5000);setInterval(loadLogs,4000);
</script>
</body></html>`;

export function createAdminServer({
  settingsFile = "runtime/admin/settings.json",
  brainUrl = "http://127.0.0.1:3000",
  bridgeToken = "dev-only-change-me",
  fetchImpl = fetch,
  execute = run,
  logger = console,
} = {}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/") return send(response, 200, PAGE, "text/html; charset=utf-8");
      if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/api/settings") return send(response, 200, await readRuntimeSettings(settingsFile, logger));
      if (request.method === "PUT" && url.pathname === "/api/settings") return send(response, 200, await writeRuntimeSettings(settingsFile, await readJson(request)));
      if (request.method === "GET" && url.pathname === "/api/status") {
        const [brain, bedrock] = await Promise.all([
          probe(`${brainUrl}/health`, fetchImpl),
          execute("container", ["exec", "mc-wizard-bedrock", "true"]),
        ]);
        return send(response, 200, { bedrock: bedrock.code === 0, brain: Boolean(brain.ok), provider: Boolean(brain.provider && brain.provider !== "offline"), providerName: brain.provider || "Offline" });
      }
      if (request.method === "GET" && url.pathname === "/api/logs") {
        const result = await execute("container", ["logs", "-n", "120", "mc-wizard-bedrock"]);
        return send(response, result.code === 0 ? 200 : 503, result.code === 0 ? { logs: result.output } : { error: result.output || "Bedrock logs unavailable" });
      }
      if (request.method === "POST" && url.pathname === "/api/console") {
        const command = validateConsoleCommand((await readJson(request)).command);
        const result = await sendBedrockCommand(execute, command);
        if (result.code !== 0) throw Object.assign(new Error(result.output || "console command failed"), { status: 503 });
        logger.log(`[admin] Bedrock command: ${command.split(/\s+/)[0]}`);
        return send(response, 200, { sent: true, command });
      }
      if (request.method === "POST" && url.pathname === "/api/ask") {
        const body = await readJson(request);
        const question = typeof body.question === "string" ? body.question.trim() : "";
        if (!question || question.length > 800) throw Object.assign(new Error("question must be 1-800 characters"), { status: 400 });
        const result = await fetchImpl(`${brainUrl}/v1/ask`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bridgeToken}` }, body: JSON.stringify({ player: "AdminPanel", question, mode: body.mode === "general" ? "general" : "wizard" }) });
        return send(response, result.status, await result.json());
      }
      if (request.method === "DELETE" && url.pathname === "/api/session") {
        const body = await readJson(request);
        const result = await fetchImpl(`${brainUrl}/v1/session`, { method: "DELETE", headers: { "content-type": "application/json", authorization: `Bearer ${bridgeToken}` }, body: JSON.stringify({ player: "AdminPanel", mode: body.mode === "general" ? "general" : "wizard" }) });
        return send(response, result.status, await result.json());
      }
      return send(response, 404, { error: "not found" });
    } catch (error) {
      if (!error.status || error.status >= 500) logger.error(`[admin] ${error.stack || error}`);
      return send(response, error.status || 500, { error: error.status ? error.message : "internal error" });
    }
  });
}

export async function startAdminServer({ env = process.env, logger = console } = {}) {
  const host = env.ADMIN_HOST || "127.0.0.1";
  if (!/^127(?:\.\d{1,3}){3}$/.test(host) && host !== "::1" && host !== "localhost") {
    throw new Error("Admin panel is loopback-only; ADMIN_HOST must be localhost");
  }
  const port = Number(env.ADMIN_PORT) || 3001;
  const brainHost = env.HOST || "127.0.0.1";
  const server = createAdminServer({
    settingsFile: env.RUNTIME_SETTINGS_FILE || "runtime/admin/settings.json",
    brainUrl: `http://${brainHost}:${env.PORT || 3000}`,
    bridgeToken: env.BRIDGE_TOKEN || "dev-only-change-me",
    logger,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  logger.log(`[admin] operator desk listening on http://${host}:${port}`);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startAdminServer().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
