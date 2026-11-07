
require("dotenv").config();

const express = require("express");
const pino = require("pino");
const crypto = require("crypto");
const QRCode = require("qrcode");
const baileys = require("@whiskeysockets/baileys");

const makeWASocket = baileys.default;
const DisconnectReason = baileys.DisconnectReason || {};
const { usePostgresAuthState } = require("./auth-state");
const { initializeDatabase, query } = require("./db");
const { attachGroupHandlers } = require("./group");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.API_TOKEN;
const OWNER = process.env.OWNER_NAME || "YVONNIE2005";

const accounts = new Map();
const sessions = new Map();
const ipAttempts = new Map();

const SESSION_TTL = 15 * 60 * 1000;
const MAX_SESSIONS = 25;
const MAX_ATTEMPTS = 12;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function apiAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || !safeEqual(token, TOKEN)) {
    return res.status(401).json({ error: "Unauthorized. Check your admin token." });
  }
  next();
}

function sessionAuth(req, res, next) {
  const session = sessions.get(req.params.id);
  const token = String(req.headers["x-session-token"] || "");

  if (!session || session.expiresAt < Date.now()) {
    return res.status(404).json({ error: "Session expired. Start a new session." });
  }
  if (!safeEqual(token, session.token)) {
    return res.status(401).json({ error: "Invalid session token." });
  }
  next();
}

function rateLimit(req, res, next) {
  const ip = String(
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    "unknown"
  ).split(",")[0].trim();

  const now = Date.now();
  const attempts = (ipAttempts.get(ip) || [])
    .filter(time => now - time < 60 * 60 * 1000);

  if (attempts.length >= MAX_ATTEMPTS) {
    return res.status(429).json({
      error: "Too many attempts. Please wait before trying again."
    });
  }

  attempts.push(now);
  ipAttempts.set(ip, attempts);
  next();
}

async function startAccount(id) {
  if (accounts.has(id)) return accounts.get(id);

  const { state, saveCreds } = await usePostgresAuthState(id);

  const account = {
    id,
    socket: null,
    qr: null,
    status: "connecting",
    lastError: null,
    pairingCode: null,
    pairingPromise: null,
    intentionalClose: false
  };

  accounts.set(id, account);

  try {
    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["YVONNIE2005", "Chrome", "1.0.0"],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    account.socket = socket;

    socket.ev.on("creds.update", async () => {
      try {
        await saveCreds();
      } catch (error) {
        console.error("Credential save failed:", error.message);
        account.lastError = "Could not save WhatsApp credentials.";
      }
    });

    attachGroupHandlers(socket);

    socket.ev.on("connection.update", update => {
      if (update.qr) {
        account.qr = update.qr;
        account.status = "qr";
        account.lastError = null;
      }

      if (update.connection === "connecting") {
        account.status = "connecting";
      }

      if (update.connection === "open") {
        account.status = "connected";
        account.qr = null;
        account.lastError = null;
        console.log("WhatsApp connected:", id);

        const session = sessions.get(id);
        if (session) session.connected = true;
      }

      if (update.connection === "close") {
        account.qr = null;
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        account.status = loggedOut ? "logged_out" : "disconnected";
        account.lastError = loggedOut
          ? "WhatsApp logged out. Reconnect your account."
          : "WhatsApp connection closed. You can try reconnecting.";

        console.log("WhatsApp connection closed:", id, statusCode || "unknown");
      }
    });

    return account;
  } catch (error) {
    accounts.delete(id);
    throw error;
  }
}

function endSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  const account = accounts.get(id);

  if (account && account.status === "connected") {
    sessions.delete(id);
    return;
  }

  if (account?.socket) {
    account.intentionalClose = true;
    try {
      account.socket.end(new Error("Pairing session expired"));
    } catch (_) {}
    accounts.delete(id);
  }

  sessions.delete(id);
}

async function createPublicSession() {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error("Portal is busy. Please try again shortly.");
  }

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");

  sessions.set(id, {
    token,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL,
    connected: false
  });

  try {
    await startAccount(id);
  } catch (error) {
    sessions.delete(id);
    throw error;
  }

  const timer = setTimeout(() => endSession(id), SESSION_TTL);
  if (timer.unref) timer.unref();

  return { id, token };
}

/* HIGH-TECH PUBLIC LANDING PAGE */

app.get("/", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#07130f">
<title>YVONNIE2005 | WhatsApp Automation</title>
<style>
:root{--bg:#06110d;--panel:#10251c;--green:#9af0b5;--muted:#a9c4b2;--line:#28543b}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:radial-gradient(ellipse at 50% -10%,#1c5838 0%,var(--bg) 55%);color:#f2fff6;font-family:Inter,Arial,sans-serif}
a{color:inherit;text-decoration:none}
nav{position:sticky;top:0;z-index:5;display:flex;justify-content:space-between;align-items:center;padding:17px 6%;background:#06110de8;backdrop-filter:blur(14px);border-bottom:1px solid #214532}
.logo{font-weight:900;letter-spacing:1px;color:var(--green)}
.links{display:flex;gap:20px;align-items:center;font-size:14px;color:var(--muted)}
.btn{display:inline-block;padding:13px 20px;border-radius:12px;background:var(--green);color:#092014;font-weight:800;border:0}
.btn.secondary{background:#173c29;color:white;border:1px solid #3a7650}
.hero{min-height:76vh;display:grid;place-items:center;text-align:center;padding:75px 20px}
.hero-inner{max-width:850px}
.tag{display:inline-block;padding:9px 14px;border:1px solid #397c50;border-radius:30px;color:var(--green);background:#10291d}
h1{font-size:clamp(42px,8vw,78px);line-height:1.03;margin:24px 0}
h1 span{color:var(--green)}
p{color:var(--muted);line-height:1.7}
.hero p{font-size:18px;max-width:680px;margin:0 auto 28px}
.actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
section{padding:65px 7%;max-width:1250px;margin:auto}
.section-title{text-align:center;margin-bottom:35px}
.section-title h2{font-size:34px;margin:0 0 10px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:17px}
.card{padding:24px;border-radius:18px;background:linear-gradient(145deg,#132d20,#0b1c13);border:1px solid var(--line)}
.card .symbol{font-size:28px}
.card h3{color:var(--green)}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:15px}
.step{padding:22px;border-left:3px solid var(--green);background:#10251c;border-radius:12px}
.step b{font-size:22px;color:var(--green)}
.cta{text-align:center;border:1px solid var(--line);background:#10251c;border-radius:25px;padding:45px 20px}
footer{text-align:center;padding:35px;color:#91ad9a;border-top:1px solid #1c3828}
@media(max-width:650px){.links a:not(.btn){display:none}.hero{min-height:70vh}section{padding:48px 6%}}
</style>
</head>
<body>
<nav>
<a class="logo" href="/">YVONNIE2005</a>
<div class="links">
<a href="#features">Features</a>
<a href="/faq">FAQ & Guide</a>
<a href="/admin">Admin</a>
<a class="btn" href="/connect">Connect WhatsApp</a>
</div>
</nav>

<header class="hero">
<div class="hero-inner">
<div class="tag">● MULTI-DEVICE WHATSAPP BOT</div>
<h1>Smarter WhatsApp.<br><span>More possibilities.</span></h1>
<p>Meet YVONNIE2005 — a WhatsApp automation platform with group assistance, AI-powered conversations, administration tools and a simple account connection portal.</p>
<div class="actions">
<a class="btn" href="/connect">Connect your WhatsApp →</a>
<a class="btn secondary" href="/faq">Read setup guide</a>
</div>
</div>
</header>

<section id="features">
<div class="section-title"><h2>Powerful bot capabilities</h2><p>A growing collection of tools for everyday WhatsApp communities.</p></div>
<div class="grid">
<div class="card"><div class="symbol">🤖</div><h3>AI Assistant</h3><p>Ask questions, get explanations and receive help with writing and learning.</p></div>
<div class="card"><div class="symbol">👥</div><h3>Group Tools</h3><p>Group information, member tagging, rules and admin utilities.</p></div>
<div class="card"><div class="symbol">🛡️</div><h3>Administration</h3><p>Permission-aware group management and moderation commands.</p></div>
<div class="card"><div class="symbol">🎵</div><h3>Media Features</h3><p>Media commands are being expanded and may require external service integrations.</p></div>
<div class="card"><div class="symbol">⚡</div><h3>Multi-device</h3><p>Connect using a QR code or WhatsApp phone-number pairing.</p></div>
<div class="card"><div class="symbol">📊</div><h3>Control Centre</h3><p>Protected administrator tools for monitoring service and account status.</p></div>
</div>
</section>

<section>
<div class="section-title"><h2>Connect in a few steps</h2><p>Use an account you own or are authorized to connect.</p></div>
<div class="steps">
<div class="step"><b>01</b><h3>Open the portal</h3><p>Choose QR code or phone-number pairing.</p></div>
<div class="step"><b>02</b><h3>Link WhatsApp</h3><p>Follow the instructions shown on the connection page.</p></div>
<div class="step"><b>03</b><h3>Start using the bot</h3><p>Once connected, use the available bot commands in your groups.</p></div>
</div>
</section>

<section>
<div class="cta">
<h2>Ready to connect?</h2>
<p>Open the secure connection portal and follow the setup guide.</p>
<a class="btn" href="/connect">Open connection portal</a>
<a class="btn secondary" href="/faq">View FAQ</a>
</div>
</section>

<footer>© ${new Date().getFullYear()} YVONNIE2005 · WhatsApp automation platform</footer>
</body>
</html>`);
});

/* PUBLIC CONNECTION PORTAL */

app.get("/connect", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect | YVONNIE2005</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;padding:20px;display:grid;place-items:center;background:radial-gradient(circle at top,#17452e,#07130f 65%);color:#eef8f1;font-family:Arial,sans-serif}
main{width:min(100%,520px);padding:26px;background:#10251c;border:1px solid #326044;border-radius:22px;box-shadow:0 20px 65px #0009}
a{color:#b8efc8}h1{color:#b8efc8;margin:0 0 8px}
p{color:#bfd2c5;line-height:1.55}
.tabs{display:flex;gap:9px;margin:22px 0}
button{border:0;border-radius:11px;padding:14px;background:#b8efc8;color:#10251c;font-weight:bold;cursor:pointer}
button:disabled{opacity:.55}
.tabs button{flex:1;background:#1d3b2c;color:white}
.tabs button.active{background:#b8efc8;color:#10251c}
input{width:100%;padding:15px;border-radius:10px;border:1px solid #456c54;background:#08170f;color:white;margin:10px 0 14px;font-size:16px}
.panel{display:none}.panel.active{display:block}
.result{text-align:center;margin-top:17px;overflow-wrap:anywhere}
#qr{width:250px;height:250px;background:white;padding:8px;border-radius:12px;display:none;margin:15px auto}
#code{font-size:28px;letter-spacing:3px;font-weight:bold;color:#b8efc8}
.small{font-size:12px;color:#9eb8a6}.error{color:#ffb4a9}.status{min-height:25px}
</style>
</head>
<body>
<main>
<a href="/">← Home</a>
<h1>Connect WhatsApp</h1>
<p>Connect an account you own or are authorized to use.</p>
<div class="tabs">
<button id="qrTab" class="active">QR CODE</button>
<button id="codeTab">PAIRING CODE</button>
</div>
<div id="qrPanel" class="panel active">
<p>Open WhatsApp → Linked devices → Link a device.</p>
<button id="startQr">Generate QR Code</button>
<div class="result"><img id="qr" alt="WhatsApp QR code"><p id="qrStatus" class="status"></p></div>
</div>
<div id="codePanel" class="panel">
<p>Enter your WhatsApp number with country code, without spaces.</p>
<input id="phone" inputmode="numeric" placeholder="2567XXXXXXXX">
<button id="startCode">Get Pairing Code</button>
<div class="result"><div id="code"></div><p id="codeStatus" class="status"></p></div>
</div>
<p class="small">Sessions expire after 15 minutes if not connected. Never share your QR or pairing code.</p>
<p id="error" class="error"></p>
<p><a href="/faq">Need help? Read the pairing guide and FAQ.</a></p>
</main>
<script>
let sessionId=null,sessionToken=null,poller=null,busy=false;
const el=id=>document.getElementById(id);

function showTab(tab){
 el("qrPanel").classList.toggle("active",tab==="qr");
 el("codePanel").classList.toggle("active",tab==="code");
 el("qrTab").classList.toggle("active",tab==="qr");
 el("codeTab").classList.toggle("active",tab==="code");
 el("error").textContent="";
}
el("qrTab").onclick=()=>showTab("qr");
el("codeTab").onclick=()=>showTab("code");

async function createSession(){
 const response=await fetch("/public/sessions",{method:"POST"});
 const data=await response.json();
 if(!response.ok)throw new Error(data.error||"Could not start session");
 sessionId=data.id;sessionToken=data.token;
}
async function sessionRequest(path,options={}){
 const response=await fetch(path,{
  ...options,
  headers:{"Content-Type":"application/json","x-session-token":sessionToken,...(options.headers||{})}
 });
 const data=await response.json();
 if(!response.ok){
  if(response.status===404||response.status===410){sessionId=null;sessionToken=null;}
  throw new Error(data.error||"Request failed");
 }
 return data;
}
function stopPolling(){if(poller){clearInterval(poller);poller=null;}}
async function pollQR(){
 try{
  const data=await sessionRequest("/public/sessions/"+sessionId+"/qr");
  if(data.qr){
   el("qr").src=data.qr;el("qr").style.display="block";
   el("qrStatus").textContent="Scan this code using WhatsApp.";
  }else if(data.status==="connected"){
   el("qr").style.display="none";
   el("qrStatus").textContent="WhatsApp connected successfully!";
   stopPolling();
  }else{
   el("qrStatus").textContent="Waiting for WhatsApp QR code...";
  }
  if(data.status==="disconnected"||data.status==="logged_out"){
   el("qrStatus").textContent="Connection ended. Start a new session.";
   stopPolling();sessionId=null;sessionToken=null;
  }
 }catch(error){el("qrStatus").textContent=error.message;stopPolling();}
}
el("startQr").onclick=async()=>{
 if(busy)return;busy=true;el("startQr").disabled=true;
 el("error").textContent="";el("qr").style.display="none";
 try{
  stopPolling();sessionId=null;sessionToken=null;
  await createSession();
  el("qrStatus").textContent="Waiting for WhatsApp QR code...";
  await pollQR();
  if(sessionId)poller=setInterval(pollQR,2500);
 }catch(error){el("error").textContent=error.message;}
 finally{busy=false;el("startQr").disabled=false;}
};
el("startCode").onclick=async()=>{
 if(busy)return;busy=true;el("startCode").disabled=true;
 el("error").textContent="";el("code").textContent="";
 try{
  stopPolling();sessionId=null;sessionToken=null;
  const phone=el("phone").value.replace(/\\D/g,"");
  if(phone.length<8||phone.length>15)throw new Error("Enter a valid international phone number.");
  await createSession();
  el("codeStatus").textContent="Requesting pairing code...";
  const data=await sessionRequest("/public/sessions/"+sessionId+"/pair-code",{
   method:"POST",body:JSON.stringify({phone})
  });
  el("code").textContent=data.pairingCode;
  el("codeStatus").textContent="WhatsApp → Linked devices → Link with phone number.";
 }catch(error){el("error").textContent=error.message;el("codeStatus").textContent="";}
 finally{busy=false;el("startCode").disabled=false;}
};
</script>
</body>
</html>`);
});

/* FAQ AND PAIRING GUIDE */

app.get("/faq", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FAQ & Pairing Guide | YVONNIE2005</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#07130f;color:#effff3;font-family:Arial,sans-serif}
header{padding:28px 7%;background:#10251c;border-bottom:1px solid #28543b}
a{color:#9af0b5}main{max-width:950px;margin:auto;padding:35px 6%}
h1,h2{color:#9af0b5}.item{padding:20px;margin:13px 0;background:#10251c;border:1px solid #28543b;border-radius:14px}
.item h3{margin-top:0}.item p{color:#bdd2c3;line-height:1.7}
li{color:#bdd2c3;line-height:1.8}
</style>
</head>
<body>
<header><a href="/">← YVONNIE2005 Home</a><h1>Help Centre & FAQ</h1><p>Connection instructions, pairing help and frequently asked questions.</p></header>
<main>
<h2>QR code pairing</h2>
<div class="item"><h3>Step 1 — Open the connection portal</h3><p>Visit <a href="/connect">the connection page</a> and choose QR CODE.</p></div>
<div class="item"><h3>Step 2 — Generate your QR code</h3><p>Tap Generate QR Code and wait for the code to appear.</p></div>
<div class="item"><h3>Step 3 — Open WhatsApp</h3><p>On your phone, open WhatsApp → Linked devices → Link a device. Scan the QR code displayed on the portal.</p></div>
<div class="item"><h3>Step 4 — Wait for confirmation</h3><p>Keep the page open while the connection completes. The portal will report when WhatsApp is connected.</p></div>

<h2>Phone-number pairing</h2>
<div class="item"><h3>How do I use a pairing code?</h3>
<ol>
<li>Open <a href="/connect">the connection portal</a>.</li>
<li>Select PAIRING CODE.</li>
<li>Enter your phone number with its country code. For Uganda, start with 256.</li>
<li>Tap Get Pairing Code.</li>
<li>In WhatsApp, open Linked devices → Link with phone number instead.</li>
<li>Enter the code shown on the portal.</li>
</ol></div>

<h2>Frequently asked questions</h2>
<div class="item"><h3>Why is my QR code not appearing?</h3><p>Wait a short time for WhatsApp to initialize. Refresh the portal and start a new session if the previous one has expired. Check the service health at <a href="/health">the health page</a>.</p></div>
<div class="item"><h3>Why does it say WhatsApp session ended?</h3><p>Pairing sessions expire if they are not completed within 15 minutes. Return to the connection page and generate a new session.</p></div>
<div class="item"><h3>What does too many attempts mean?</h3><p>The portal limits repeated connection requests to protect the service. Wait for the limit window to pass before trying again. Avoid repeatedly refreshing or requesting new codes.</p></div>
<div class="item"><h3>My pairing code failed. What should I do?</h3><p>Check the country code and phone number, ensure the WhatsApp app is updated, and use the latest code from a fresh session. Do not reuse an expired code.</p></div>
<div class="item"><h3>Can I connect someone else's WhatsApp?</h3><p>Only connect an account you own or have clear authorization to manage. The account owner should perform the linking process themselves.</p></div>
<div class="item"><h3>Does the bot need to remain connected?</h3><p>The WhatsApp linked-device session must remain valid. If WhatsApp logs it out, reconnect using the portal.</p></div>
<div class="item"><h3>Where can I find bot commands?</h3><p>In a group where the bot is active, try <b>.menu</b> or <b>.help</b>. Some advanced media commands require additional integrations.</p></div>
<div class="item"><h3>How do I contact the administrator?</h3><p>Use the official contact channel provided by the platform owner. Never send your API token, QR code or pairing code to anyone.</p></div>

<p><a href="/connect">← Return to connection portal</a> · <a href="/">Home</a></p>
</main>
</body>
</html>`);
});

/* ADMIN CONTROL CENTRE */

app.get("/admin", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#07130f">
<title>Admin Control Centre | YVONNIE2005</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#07130f;color:#effff3;font-family:Arial,sans-serif}
a{color:#9af0b5}
header{padding:20px 5%;background:#10251c;border-bottom:1px solid #28543b;display:flex;justify-content:space-between;align-items:center}
h1,h2,h3{color:#9af0b5}
main{max-width:1150px;margin:auto;padding:25px 5%}
.panel{background:#10251c;border:1px solid #28543b;border-radius:17px;padding:22px;margin-bottom:18px}
input{width:100%;max-width:500px;padding:14px;border-radius:10px;border:1px solid #456c54;background:#08170f;color:white;margin:8px 0}
button{padding:12px 17px;border:0;border-radius:10px;background:#9af0b5;color:#092014;font-weight:bold;cursor:pointer}
button.secondary{background:#244b34;color:white}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:15px}
.stat{padding:20px;border-radius:14px;background:#0a1b12;border:1px solid #28543b}
.stat strong{display:block;font-size:26px;color:#9af0b5;margin-top:8px}
.hidden{display:none}
.muted{color:#a9c4b2;line-height:1.6}
table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:12px;border-bottom:1px solid #28543b}
#message{color:#9af0b5;overflow-wrap:anywhere}
@media(max-width:600px){header{align-items:flex-start;gap:12px;flex-direction:column}.panel{padding:16px}table{font-size:12px}}
</style>
</head>
<body>
<header>
<div><h2>YVONNIE2005</h2><span class="muted">ADMIN CONTROL CENTRE</span></div>
<div><a href="/">Public site</a> · <a href="/connect">Connect</a> · <a href="/faq">FAQ</a></div>
</header>
<main>
<section class="panel" id="login">
<h1>Administrator sign in</h1>
<p class="muted">Enter the API_TOKEN configured privately in your hosting environment. It is not stored in the public website.</p>
<input id="token" type="password" autocomplete="current-password" placeholder="Administrator API token">
<br><button id="loginBtn">Unlock dashboard</button>
<p id="loginMessage" class="muted"></p>
</section>

<div id="dashboard" class="hidden">
<section class="panel">
<h1>System overview</h1>
<p class="muted">Live service information from this running worker instance.</p>
<div class="grid">
<div class="stat">Service status<strong id="health">Checking...</strong></div>
<div class="stat">Active worker accounts<strong id="accountsCount">—</strong></div>
<div class="stat">Pending pairing sessions<strong id="sessionsCount">—</strong></div>
<div class="stat">Server time<strong id="serverTime">—</strong></div>
</div>
</section>

<section class="panel">
<h2>WhatsApp accounts</h2>
<button id="refresh">Refresh account status</button>
<div style="overflow-x:auto;margin-top:15px">
<table><thead><tr><th>Account ID</th><th>Status</th><th>Last error</th></tr></thead>
<tbody id="accountRows"><tr><td colspan="3">No account data loaded.</td></tr></tbody></table>
</div>
</section>

<section class="panel">
<h2>Connect an existing account ID</h2>
<p class="muted">Use only an account ID already managed by the system. This action starts the worker connection process; it does not bypass WhatsApp's linking approval.</p>
<input id="accountId" placeholder="Account ID">
<br><button id="connectAccount">Start account</button>
<p id="actionMessage"></p>
</section>

<section class="panel">
<h2>Administrator tools</h2>
<div class="grid">
<div class="stat"><h3>Public portal</h3><p class="muted">Manage the user-facing connection journey.</p><a href="/connect">Open portal →</a></div>
<div class="stat"><h3>Help centre</h3><p class="muted">Review pairing and troubleshooting guidance.</p><a href="/faq">Open FAQ →</a></div>
<div class="stat"><h3>Service health</h3><p class="muted">Check the worker health endpoint.</p><a href="/health">Open health →</a></div>
</div>
</section>
<button class="secondary" id="logout">Lock dashboard</button>
</div>
</main>
<script>
const el=id=>document.getElementById(id);
let token="";
async function api(path,options={}){
 const response=await fetch(path,{
  ...options,
  headers:{
   "Content-Type":"application/json",
   "Authorization":"Bearer "+token,
   ...(options.headers||{})
  }
 });
 const data=await response.json();
 if(!response.ok)throw new Error(data.error||"Request failed");
 return data;
}
async function loadDashboard(){
 const [health,accounts]=await Promise.all([
  api("/api/health"),
  api("/api/accounts")
 ]);
 el("health").textContent=health.status||"Unknown";
 el("accountsCount").textContent=health.activeAccounts??0;
 el("sessionsCount").textContent=health.pendingSessions??0;
 el("serverTime").textContent=new Date().toLocaleTimeString();
 const rows=accounts.accounts||[];
 el("accountRows").innerHTML=rows.length?rows.map(a=>
  "<tr><td></td><td></td><td></td></tr>"
 ).join(""):"<tr><td colspan='3'>No active accounts.</td></tr>";
 [...el("accountRows").querySelectorAll("tr")].forEach((row,i)=>{
  if(rows[i]){
   row.children[0].textContent=rows[i].id;
   row.children[1].textContent=rows[i].status;
   row.children[2].textContent=rows[i].error||"—";
  }
 });
}
el("loginBtn").onclick=async()=>{
 token=el("token").value.trim();
 if(!token){el("loginMessage").textContent="Enter your admin token.";return;}
 try{
  await loadDashboard();
  el("login").classList.add("hidden");
  el("dashboard").classList.remove("hidden");
  el("loginMessage").textContent="";
 }catch(error){
  token="";
  el("loginMessage").textContent=error.message;
 }
};
el("refresh").onclick=async()=>{
 try{await loadDashboard();}catch(error){el("actionMessage").textContent=error.message;}
};
el("connectAccount").onclick=async()=>{
 const id=el("accountId").value.trim();
 if(!id){el("actionMessage").textContent="Enter an account ID.";return;}
 try{
  const result=await api("/api/accounts/"+encodeURIComponent(id)+"/connect",{method:"POST"});
  el("actionMessage").textContent="Account started: "+result.status;
  await loadDashboard();
 }catch(error){el("actionMessage").textContent=error.message;}
};
el("logout").onclick=()=>{
 token="";
 el("token").value="";
 el("dashboard").classList.add("hidden");
 el("login").classList.remove("hidden");
};
</script>
</body>
</html>`);
});

/* HEALTH ENDPOINT */

app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    service: "YVONNIE2005",
    activeAccounts: accounts.size,
    pendingSessions: sessions.size,
    timestamp: new Date().toISOString()
  });
});

/* PUBLIC SESSION CREATION */

app.post("/public/sessions", rateLimit, async (_req, res) => {
  try {
    const session = await createPublicSession();
    res.status(201).json(session);
  } catch (error) {
    console.error("Session creation failed:", error.message);
    res.status(503).json({
      error: error.message || "Could not start WhatsApp session."
    });
  }
});

/* PUBLIC QR STATUS */

app.get("/public/sessions/:id/qr", sessionAuth, async (req, res) => {
  const account = accounts.get(req.params.id);

  if (!account) {
    return res.status(410).json({ error: "WhatsApp session ended. Start again." });
  }

  if (account.status === "connected") {
    return res.json({ status: "connected", qr: null });
  }

  if (account.status === "disconnected" || account.status === "logged_out") {
    return res.json({
      status: account.status,
      qr: null,
      error: account.lastError
    });
  }

  if (!account.qr) {
    return res.json({ status: account.status, qr: null });
  }

  try {
    const qr = await QRCode.toDataURL(account.qr, { width: 280, margin: 1 });
    res.json({ status: account.status, qr });
  } catch (error) {
    res.status(500).json({ error: "QR generation failed." });
  }
});

/* PUBLIC PAIRING CODE */

app.post("/public/sessions/:id/pair-code", sessionAuth, async (req, res) => {
  const account = accounts.get(req.params.id);
  const phone = String(req.body.phone || "").replace(/\D/g, "");

  if (!account?.socket) {
    return res.status(410).json({ error: "WhatsApp session ended. Start again." });
  }

  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: "Invalid international phone number." });
  }

  if (account.status === "connected") {
    return res.status(409).json({ error: "This WhatsApp account is already connected." });
  }

  if (account.pairingCode) {
    return res.json({ success: true, pairingCode: account.pairingCode });
  }

  try {
    if (!account.pairingPromise) {
      account.pairingPromise = account.socket.requestPairingCode(phone);
    }
    const pairingCode = await account.pairingPromise;
    account.pairingCode = pairingCode;
    res.json({ success: true, pairingCode });
  } catch (error) {
    account.pairingPromise = null;
    console.error("Pairing code error:", error.message);
    res.status(503).json({
      error: "Pairing code is not ready. Wait a few seconds and try again."
    });
  }
});

/* PROTECTED ADMIN API */

app.use("/api", apiAuth);

app.get("/api/health", (_req, res) => {
  res.json({
    status: "healthy",
    activeAccounts: accounts.size,
    pendingSessions: sessions.size
  });
});

app.post("/api/accounts/:id/connect", async (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return res.status(400).json({ error: "Invalid account ID." });

  try {
    const account = await startAccount(id);
    res.json({ success: true, account: id, status: account.status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/accounts/:id/qr", (req, res) => {
  const account = accounts.get(req.params.id);
  if (!account) return res.status(404).json({ error: "Account not started." });

  res.json({
    status: account.status,
    qr: account.qr,
    error: account.lastError
  });
});

app.post("/api/accounts/:id/pair-code", async (req, res) => {
  const account = accounts.get(req.params.id);
  const phone = String(req.body.phone || "").replace(/\D/g, "");

  if (!account?.socket) {
    return res.status(404).json({ error: "Connect account first." });
  }
  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: "Invalid phone number." });
  }

  try {
    if (!account.pairingCode) {
      if (!account.pairingPromise) {
        account.pairingPromise = account.socket.requestPairingCode(phone);
      }
      account.pairingCode = await account.pairingPromise;
    }
    res.json({ success: true, pairingCode: account.pairingCode });
  } catch (error) {
    account.pairingPromise = null;
    res.status(503).json({ error: "Pairing code unavailable. Try again shortly." });
  }
});

app.get("/api/accounts", (_req, res) => {
  res.json({
    accounts: [...accounts.entries()].map(([id, account]) => ({
      id,
      status: account.status,
      error: account.lastError
    }))
  });
});

/* DATABASE AND SERVER STARTUP */

async function start() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing.");
  }
  if (!TOKEN) {
    throw new Error("API_TOKEN is missing.");
  }

  await initializeDatabase();

  await query(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
      account_id TEXT NOT NULL,
      key_type TEXT,
      key_id TEXT NOT NULL,
      key_data JSONB
    )
  `);

  await query(`
    ALTER TABLE whatsapp_auth_keys
    ADD COLUMN IF NOT EXISTS key_type TEXT
  `);

  await query(`
    UPDATE whatsapp_auth_keys
    SET key_type = 'legacy'
    WHERE key_type IS NULL
  `);

  await query(`
    ALTER TABLE whatsapp_auth_keys
    ALTER COLUMN key_type SET NOT NULL
  `);

  await query(`
    DO $$
    DECLARE pk_name TEXT;
    BEGIN
      SELECT conname INTO pk_name
      FROM pg_constraint
      WHERE conrelid = 'whatsapp_auth_keys'::regclass
        AND contype = 'p';

      IF pk_name IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE whatsapp_auth_keys DROP CONSTRAINT %I',
          pk_name
        );
      END IF;

      ALTER TABLE whatsapp_auth_keys
      ADD CONSTRAINT whatsapp_auth_keys_pkey
      PRIMARY KEY (account_id, key_type, key_id);
    END $$;
  `);

  app.listen(PORT, () => {
    console.log("YVONNIE2005 running on port " + PORT);
    console.log("Public website: /");
    console.log("Connection portal: /connect");
    console.log("FAQ and pairing guide: /faq");
    console.log("Admin dashboard: /admin");
  });
}

start().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});
