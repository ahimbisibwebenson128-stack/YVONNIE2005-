
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
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.API_TOKEN;
const accounts = new Map();
const sessions = new Map();
const ipAttempts = new Map();
const SESSION_TTL = 15 * 60 * 1000;
const MAX_SESSIONS = 25;
const MAX_ATTEMPTS = 12;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
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
  const ip = String(req.ip || req.socket.remoteAddress || "unknown");
  const now = Date.now();
  const attempts = (ipAttempts.get(ip) || []).filter(t => now - t < 60 * 60 * 1000);
  if (attempts.length >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: "Too many attempts. Please wait before trying again." });
  }
  attempts.push(now);
  ipAttempts.set(ip, attempts);
  next();
}

function waitForSocketReady(account, timeoutMs = 20000) {
  if (account.socketReady && !["disconnected", "logged_out"].includes(account.status)) {
    return Promise.resolve();
  }
  if (!account.socket) return Promise.reject(new Error("WhatsApp socket is unavailable."));
  return new Promise((resolve, reject) => {
    const socket = account.socket;
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.ev.removeListener("connection.update", listener);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const listener = update => {
      if (update.qr || update.connection === "open") {
        account.socketReady = true;
        finish(resolve);
      } else if (update.connection === "close") {
        finish(reject, new Error("WhatsApp connection closed before initialization."));
      }
    };
    const timer = setTimeout(() => {
      finish(reject, new Error("WhatsApp is taking too long to initialize. Start a new session."));
    }, timeoutMs);
    socket.ev.on("connection.update", listener);
  });
}

async function startAccount(id) {
  if (accounts.has(id)) return accounts.get(id);
  const { state, saveCreds } = await usePostgresAuthState(id);
  const account = {
    id, socket: null, qr: null, status: "connecting", lastError: null,
    pairingCode: null, pairingPromise: null, socketReady: false, intentionalClose: false
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

    // IMPORTANT: Pass the account ID to the Group AI handler.
    attachGroupHandlers(socket, id);

    socket.ev.on("connection.update", update => {
      if (update.qr) {
        account.qr = update.qr;
        account.status = "qr";
        account.socketReady = true;
        account.lastError = null;
      }
      if (update.connection === "connecting") account.status = "connecting";
      if (update.connection === "open") {
        account.status = "connected";
        account.qr = null;
        account.socketReady = true;
        account.lastError = null;
        account.pairingCode = null;
        account.pairingPromise = null;
        console.log("WhatsApp connected:", id);
        const session = sessions.get(id);
        if (session) session.connected = true;
      }
      if (update.connection === "close") {
        account.qr = null;
        account.socketReady = false;
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        account.status = loggedOut ? "logged_out" : "disconnected";
        account.lastError = loggedOut
          ? "WhatsApp logged out. Reconnect your account."
          : "WhatsApp connection closed. Start a new session if needed.";
        account.pairingCode = null;
        account.pairingPromise = null;
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
  if (sessions.size >= MAX_SESSIONS) throw new Error("Portal is busy. Please try again shortly.");
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

/* Built-in YVONNIE2005 robot illustration */
const robot = `<svg viewBox="0 0 240 240" role="img" aria-label="YVONNIE2005 robot mascot">
<defs>
<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop stop-color="#b8ffd0"/><stop offset="1" stop-color="#37b978"/>
</linearGradient>
<linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
<stop stop-color="#fff0a8"/><stop offset="1" stop-color="#c99635"/>
</linearGradient>
<filter id="shadow"><feGaussianBlur stdDeviation="5"/></filter>
</defs>
<ellipse cx="120" cy="210" rx="70" ry="13" fill="#000" opacity=".35" filter="url(#shadow)"/>
<path d="M79 51 64 19l34 18M161 51l15-32-34 18" fill="url(#gold)" stroke="#ffe7a0" stroke-width="5" stroke-linejoin="round"/>
<path d="M120 8 130 27 151 30 136 45 140 66 120 56 100 66 104 45 89 30 110 27Z" fill="url(#gold)" stroke="#ffe7a0" stroke-width="3"/>
<rect x="42" y="57" width="156" height="119" rx="38" fill="url(#g)" stroke="#d6ffe2" stroke-width="5"/>
<rect x="57" y="75" width="126" height="83" rx="25" fill="#0b2118" stroke="#6ce4a0" stroke-width="3"/>
<ellipse cx="91" cy="111" rx="10" ry="14" fill="#a9ffd0"/>
<ellipse cx="149" cy="111" rx="10" ry="14" fill="#a9ffd0"/>
<path d="M94 137q26 19 52 0" fill="none" stroke="#a9ffd0" stroke-width="5" stroke-linecap="round"/>
<path d="M42 102H22v42h22M198 102h20v42h-22" fill="none" stroke="url(#gold)" stroke-width="9" stroke-linecap="round"/>
<rect x="82" y="178" width="76" height="25" rx="12" fill="url(#gold)"/>
<text x="120" y="195" text-anchor="middle" font-size="10" font-weight="900" fill="#182719">YVONNIE</text>
</svg>`;

const css = `
:root{color-scheme:dark;--bg:#050d0a;--panel:rgba(14,35,25,.78);--line:rgba(151,241,184,.2);--green:#a8f5c2;--mint:#54d995;--gold:#e6c16d;--muted:#b4c9bb;--white:#f4fff7}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:radial-gradient(ellipse at 50% -15%,#245b3c 0%,#0b1b12 34%,var(--bg) 75%);color:var(--white);font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Arial,sans-serif}
a{color:var(--green);text-decoration:none}
a:hover{color:#fff}
button,input{font:inherit}
.nav{position:sticky;top:0;z-index:10;display:flex;justify-content:space-between;align-items:center;gap:15px;padding:13px clamp(16px,5vw,65px);background:rgba(4,13,9,.82);backdrop-filter:blur(20px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:11px;font-weight:950;letter-spacing:1.4px;color:var(--green)}
.brandmark{width:42px;height:42px;display:grid;place-items:center;border:1px solid var(--line);border-radius:14px;background:#143321}
.brandmark svg{width:35px}
.navlinks{display:flex;align-items:center;gap:20px;color:var(--muted);font-size:13px}
.wrap{width:min(1160px,92%);margin:auto}
.btn{display:inline-flex;justify-content:center;align-items:center;gap:9px;padding:13px 19px;border:1px solid transparent;border-radius:13px;background:linear-gradient(135deg,#baffd0,#61d994);color:#082014;font-weight:850;box-shadow:0 10px 30px #4ad78a24;cursor:pointer}
.btn:hover{transform:translateY(-1px);color:#06140c}
.btn.alt{background:rgba(255,255,255,.05);border-color:var(--line);color:var(--white);box-shadow:none}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.eyebrow{display:inline-flex;align-items:center;gap:8px;padding:8px 13px;border:1px solid var(--line);border-radius:50px;background:#10281b;color:var(--green);font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase}
.hero{display:grid;grid-template-columns:1.15fr .85fr;align-items:center;gap:35px;padding:76px 0 68px;min-height:560px}
.hero h1{font-size:clamp(42px,7vw,76px);line-height:1.02;letter-spacing:-2.8px;margin:20px 0}
.gradient{background:linear-gradient(90deg,#c9ffda,#5edc9c,#e8d18d);background-clip:text;color:transparent}
.lead{font-size:17px;line-height:1.8;color:var(--muted);max-width:660px}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:26px}
.mascotbox{position:relative;min-height:350px;display:grid;place-items:center;border:1px solid var(--line);border-radius:34px;background:radial-gradient(circle at 50% 42%,#235b3c99,transparent 58%),linear-gradient(145deg,#193c29a8,#0a1710b8);box-shadow:inset 0 1px #ffffff12,0 25px 80px #0006;overflow:hidden}
.mascotbox:before,.mascotbox:after{content:"";position:absolute;width:240px;height:240px;border:1px solid #9af0b52b;border-radius:50%}
.mascotbox:after{width:300px;height:300px}
.mascotbox svg{width:min(78%,300px);position:relative;z-index:1;filter:drop-shadow(0 18px 30px #0008)}
.floatlabel{position:absolute;z-index:2;padding:10px 13px;border:1px solid var(--line);border-radius:13px;background:#07150fe8;color:var(--green);font-size:11px;font-weight:800;backdrop-filter:blur(10px)}
.floatlabel.one{top:23px;left:18px}
.floatlabel.two{right:18px;bottom:25px}
.section{padding:66px 0}
.sectionhead{text-align:center;max-width:720px;margin:0 auto 32px}
.sectionhead h2{font-size:clamp(28px,4vw,43px);margin:12px 0}
.sectionhead p{color:var(--muted);line-height:1.7}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{padding:23px;border:1px solid var(--line);border-radius:20px;background:linear-gradient(145deg,rgba(24,55,37,.8),rgba(9,23,15,.86));box-shadow:inset 0 1px #ffffff0b}
.card .ico{width:48px;height:48px;display:grid;place-items:center;border-radius:15px;background:#b3ffd21a;border:1px solid var(--line);font-size:23px}
.card h3{color:var(--green);margin:17px 0 8px}
.card p{color:var(--muted);line-height:1.7;font-size:14px;margin:0}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}
.step{padding:22px;border-left:2px solid var(--gold);border-radius:0 17px 17px 0;background:#ffffff08}
.step b{font-size:28px;color:var(--gold)}
.step h3{margin:10px 0}
.step p{color:var(--muted);line-height:1.65;font-size:14px}
.banner{padding:36px;text-align:center;border:1px solid var(--line);border-radius:25px;background:radial-gradient(circle at top,#25583a88,transparent 65%),#102419}
.banner h2{font-size:32px;margin:0 0 10px}
.banner p{color:var(--muted)}
.footer{padding:30px 0;text-align:center;color:#88a795;border-top:1px solid var(--line);font-size:12px}
.portal{width:min(1120px,94%);margin:34px auto 60px}
.portalhead{text-align:center;padding:25px 0 30px}
.portalhead .mascotmini{width:96px;height:96px;margin:auto auto 12px;display:grid;place-items:center;border:1px solid var(--line);border-radius:28px;background:#153523}
.mascotmini svg{width:88px}
.portalhead h1{font-size:clamp(32px,5vw,49px);margin:12px 0}
.portalhead p{color:var(--muted);line-height:1.7}
.portalgrid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(270px,.9fr);gap:18px;align-items:start}
.glass{padding:25px;border:1px solid var(--line);border-radius:23px;background:var(--panel);backdrop-filter:blur(18px);box-shadow:0 22px 60px #0005}
.tabs{display:flex;gap:8px;padding:6px;border:1px solid var(--line);border-radius:14px;background:#06120c}
.tabs button{flex:1;padding:12px 8px;border:0;border-radius:10px;background:transparent;color:var(--muted);font-weight:850;cursor:pointer}
.tabs button.active{background:linear-gradient(135deg,#baffd0,#61d994);color:#082014}
.panel{display:none}
.panel.active{display:block}
.panel h2{margin:22px 0 7px}
.muted{color:var(--muted);line-height:1.7}
.field{width:100%;padding:15px 16px;margin:12px 0;border:1px solid #47765a;border-radius:12px;background:#06140c;color:#fff;outline:none}
.field:focus{border-color:var(--green);box-shadow:0 0 0 3px #a8f5c21b}
.result{margin-top:17px;text-align:center;overflow-wrap:anywhere}
.qrimage{display:none;width:min(280px,100%);height:auto;margin:15px auto;padding:9px;background:white;border-radius:17px}
.paircode{font-size:clamp(24px,6vw,34px);font-weight:950;letter-spacing:4px;color:var(--green);margin:14px 0}
.status{min-height:24px;font-size:13px;color:var(--green)}
.error{color:#ffb5a8}
.note{padding:14px;border:1px solid var(--line);border-radius:14px;background:#ffffff06;color:var(--muted);font-size:12px;line-height:1.7}
.sidecards{display:grid;gap:12px}
.sidecards .card{padding:18px}
.sidecards h3{margin:10px 0 5px}
.sidecards p{font-size:13px}
.faq{display:grid;gap:10px}
.faq details{padding:17px 19px;border:1px solid var(--line);border-radius:15px;background:#ffffff08}
.faq summary{cursor:pointer;color:var(--green);font-weight:800}
.faq details p{color:var(--muted);line-height:1.7;margin-bottom:0}
.adminwrap{width:min(1120px,94%);margin:32px auto}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.stat{padding:18px;border:1px solid var(--line);border-radius:16px;background:#ffffff08;color:var(--muted)}
.stat strong{display:block;font-size:25px;color:var(--green);margin-top:7px}
.tablewrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
td,th{text-align:left;padding:12px;border-bottom:1px solid var(--line)}
th{color:var(--green)}
@media(max-width:800px){
  .hero{grid-template-columns:1fr;padding:48px 0}
  .mascotbox{min-height:270px}
  .grid{grid-template-columns:repeat(2,1fr)}
  .portalgrid{grid-template-columns:1fr}
  .stats{grid-template-columns:repeat(2,1fr)}
}
@media(max-width:540px){
  .navlinks a:not(.btn){display:none}
  .grid,.steps{grid-template-columns:1fr}
  .glass{padding:18px}
  .portal{margin-top:18px}
  .hero h1{letter-spacing:-1.5px}
  .mascotbox{min-height:230px}
  .section{padding:48px 0}
  .banner{padding:26px 18px}
}
`;

function page(title, body, extra = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#07130f">
<meta name="description" content="YVONNIE2005 WhatsApp automation and connection portal">
<title>${title}</title><style>${css}${extra}</style></head><body>${body}</html>`;
}

function nav() {
  return `<nav class="nav"><a class="brand" href="/"><span class="brandmark">${robot}</span>YVONNIE2005</a>
  <div class="navlinks"><a href="/#features">Features</a><a href="/faq">Help & FAQ</a><a href="/admin">Control centre</a><a class="btn" href="/connect">Connect WhatsApp</a></div></nav>`;
}

/* PUBLIC LANDING PAGE */
app.get("/", (_req, res) => {
  const body = `${nav()}<main class="wrap">
  <header class="hero"><div><span class="eyebrow">✦ WhatsApp automation platform</span>
  <h1>Make WhatsApp work <span class="gradient">smarter.</span></h1>
  <p class="lead">Meet YVONNIE2005 — a multi-device WhatsApp assistant built for helpful conversations, group tools and simpler community management.</p>
  <div class="actions"><a class="btn" href="/connect">Connect your WhatsApp <span>→</span></a><a class="btn alt" href="/faq">Explore the guide</a></div>
  </div><div class="mascotbox"><span class="floatlabel one">✦ YOUR SMART ASSISTANT</span>${robot}<span class="floatlabel two">YVONNIE2005 BOT</span></div></header>
  <section class="section" id="features"><div class="sectionhead"><span class="eyebrow">Platform highlights</span><h2>Tools for your WhatsApp world</h2><p>Explore the current bot capabilities. Some advanced features need additional providers or configuration before they can be used.</p></div>
  <div class="grid">
  <article class="card"><div class="ico">🤖</div><h3>AI assistant</h3><p>AI-powered question and answer experiences, writing help and everyday assistance when an AI provider is configured.</p></article>
  <article class="card"><div class="ico">👥</div><h3>Group utilities</h3><p>Group help, rules and supported community tools for smoother conversations.</p></article>
  <article class="card"><div class="ico">🛡️</div><h3>Moderation</h3><p>Tools for safer group administration and moderation where the bot has the required permissions.</p></article>
  <article class="card"><div class="ico">⚡</div><h3>QR & pairing</h3><p>Link an authorized WhatsApp account using a QR code or phone-number pairing code.</p></article>
  <article class="card"><div class="ico">🎧</div><h3>Media commands</h3><p>Media-related commands can be extended with supported external services and providers.</p></article>
  <article class="card"><div class="ico">📊</div><h3>Admin control</h3><p>A protected control centre for service health and connected worker-account status.</p></article>
  </div></section>
  <section class="section"><div class="sectionhead"><span class="eyebrow">Simple setup</span><h2>Connect in three steps</h2><p>Keep your phone nearby and use an account you own or are authorized to manage.</p></div>
  <div class="steps"><div class="step"><b>01</b><h3>Open connection</h3><p>Choose QR code or phone-number pairing from the secure connection portal.</p></div><div class="step"><b>02</b><h3>Link your device</h3><p>Follow the WhatsApp Linked devices instructions and complete the pairing on your phone.</p></div><div class="step"><b>03</b><h3>You're connected</h3><p>Wait for the portal to confirm the connection, then try the commands currently supported by the bot.</p></div></div></section>
  <section class="section"><div class="banner"><h2>Ready to meet your assistant?</h2><p>Start with the secure pairing portal. Need help? The guide explains each step.</p><div class="actions" style="justify-content:center"><a class="btn" href="/connect">Open connection portal →</a><a class="btn alt" href="/faq">Read FAQ</a></div></div></section>
  </main><footer class="footer">© ${new Date().getFullYear()} YVONNIE2005 · Built for smarter WhatsApp communities</footer>`;
  res.type("html").send(page("YVONNIE2005 | WhatsApp Automation", body));
});

/* PUBLIC CONNECTION PORTAL */
app.get("/connect", (_req, res) => {
  const body = `${nav()}<main class="portal">
  <header class="portalhead"><div class="mascotmini">${robot}</div><span class="eyebrow">Secure device linking</span><h1>Connect <span class="gradient">WhatsApp</span></h1><p>Pair an account you own or have permission to manage. Choose your preferred connection method below.</p></header>
  <div class="portalgrid"><section class="glass">
  <div class="tabs"><button id="qrTab" class="active" type="button">▦ QR CODE</button><button id="codeTab" type="button">⌁ PAIRING CODE</button></div>
  <div id="qrPanel" class="panel active"><h2>Scan to connect</h2><p class="muted">Open WhatsApp on your phone, go to Linked devices, choose Link a device, then scan the QR code generated here.</p>
  <button id="startQr" class="btn" type="button">Generate QR code →</button><div class="result"><img id="qr" class="qrimage" alt="WhatsApp linking QR code"><p id="qrStatus" class="status" aria-live="polite">Your QR code will appear here.</p></div></div>
  <div id="codePanel" class="panel"><h2>Use your phone number</h2><p class="muted">Enter your full international number, including country code, without spaces or plus signs. Uganda numbers begin with 256.</p>
  <label for="phone" class="muted">WhatsApp phone number</label><input id="phone" class="field" type="tel" inputmode="numeric" autocomplete="tel" placeholder="2567XXXXXXXX">
  <button id="startCode" class="btn" type="button">Generate pairing code →</button><div class="result"><div id="code" class="paircode"></div><p id="codeStatus" class="status" aria-live="polite">Your pairing code will appear here.</p></div></div>
  <p id="error" class="error" role="alert"></p><div class="note">⏱ Pairing sessions expire after 15 minutes if not completed. Never share your QR code or pairing code with anyone. Only link accounts you own or are authorized to manage.</div>
  </section>
  <aside class="sidecards"><article class="card"><div class="ico">🔐</div><h3>Private session</h3><p>Each connection attempt receives a temporary session token.</p></article><article class="card"><div class="ico">📱</div><h3>Use WhatsApp settings</h3><p>Open Linked devices on your phone to complete QR or phone-number linking.</p></article><article class="card"><div class="ico">🆘</div><h3>Need a hand?</h3><p>See illustrated steps and troubleshooting answers in the help centre.</p><a href="/faq">Open pairing guide →</a></article></aside></div>
  <section class="section"><div class="sectionhead"><span class="eyebrow">How it works</span><h2>Pair safely, step by step</h2></div><div class="steps"><div class="step"><b>01</b><h3>Choose a method</h3><p>Generate a fresh QR code or request a phone-number pairing code.</p></div><div class="step"><b>02</b><h3>Confirm on your phone</h3><p>Use WhatsApp's Linked devices menu to approve the connection.</p></div><div class="step"><b>03</b><h3>Wait for confirmation</h3><p>Keep this page open until it reports that the account is connected.</p></div></div></section>
  <section class="section"><div class="sectionhead"><span class="eyebrow">Quick answers</span><h2>Connection FAQ</h2></div><div class="faq">
  <details><summary>Where do I find Linked devices?</summary><p>Open WhatsApp on your phone. On Android, tap the three-dot menu and choose Linked devices. On iPhone, open WhatsApp Settings and choose Linked Devices.</p></details>
  <details><summary>My QR code is not showing. What should I do?</summary><p>Wait a few seconds for the worker to initialize. If no QR appears or the session ends, start a fresh session. Repeated attempts may trigger the temporary rate limit.</p></details>
  <details><summary>How do I use the pairing code?</summary><p>Choose Pairing Code, enter your international number, then in WhatsApp choose Linked devices and Link with phone number instead. Enter the code displayed here.</p></details>
  <details><summary>Is it safe to share my code?</summary><p>No. Treat your QR code and pairing code like a password. Only enter them in the official WhatsApp app on your own device.</p></details>
  <details><summary>How long does a session last?</summary><p>An uncompleted portal session expires after 15 minutes. Start a new session if it expires.</p></details>
  </div><p style="text-align:center;margin-top:20px"><a href="/faq">View the full help centre and more troubleshooting →</a></p></section>
  </main><footer class="footer">© ${new Date().getFullYear()} YVONNIE2005 · <a href="/">Home</a> · <a href="/faq">Help centre</a></footer>
  <script>
  let sessionId=null,sessionToken=null,poller=null,busy=false;
  const el=id=>document.getElementById(id);
  function showTab(tab){el("qrPanel").classList.toggle("active",tab==="qr");el("codePanel").classList.toggle("active",tab==="code");el("qrTab").classList.toggle("active",tab==="qr");el("codeTab").classList.toggle("active",tab==="code");el("error").textContent="";}
  el("qrTab").onclick=()=>showTab("qr");
  el("codeTab").onclick=()=>showTab("code");
  async function createSession(){const r=await fetch("/public/sessions",{method:"POST"});const d=await r.json();if(!r.ok)throw new Error(d.error||"Could not start session.");sessionId=d.id;sessionToken=d.token;}
  async function sessionRequest(path,options={}){const r=await fetch(path,{...options,headers:{"Content-Type":"application/json","x-session-token":sessionToken,...(options.headers||{})}});const d=await r.json();if(!r.ok){if(r.status===404||r.status===410){sessionId=null;sessionToken=null;}throw new Error(d.error||"Request failed.");}return d;}
  function stopPolling(){if(poller){clearInterval(poller);poller=null;}}
  async function pollQR(){if(!sessionId)return;try{const d=await sessionRequest("/public/sessions/"+encodeURIComponent(sessionId)+"/qr");if(d.qr){el("qr").src=d.qr;el("qr").style.display="block";el("qrStatus").textContent="Scan this code using WhatsApp → Linked devices.";}else if(d.status==="connected"){el("qr").style.display="none";el("qrStatus").textContent="✓ WhatsApp connected successfully.";stopPolling();}else{el("qrStatus").textContent="Waiting for WhatsApp QR code…";}if(["disconnected","logged_out"].includes(d.status)){el("qrStatus").textContent=d.error||"Connection ended. Start a new session.";stopPolling();sessionId=null;sessionToken=null;}}catch(e){el("qrStatus").textContent=e.message;stopPolling();}}
  el("startQr").onclick=async()=>{if(busy)return;busy=true;el("startQr").disabled=true;el("error").textContent="";el("qr").style.display="none";el("qrStatus").textContent="Starting secure session…";try{stopPolling();sessionId=null;sessionToken=null;await createSession();await pollQR();if(sessionId)poller=setInterval(pollQR,2500);}catch(e){el("error").textContent=e.message;}finally{busy=false;el("startQr").disabled=false;}};
  el("startCode").onclick=async()=>{if(busy)return;busy=true;el("startCode").disabled=true;el("error").textContent="";el("code").textContent="";el("codeStatus").textContent="Preparing your session…";try{stopPolling();sessionId=null;sessionToken=null;const phone=el("phone").value.replace(/\\D/g,"");if(phone.length<8||phone.length>15)throw new Error("Enter a valid international phone number.");await createSession();el("codeStatus").textContent="Waiting for WhatsApp to initialize…";const d=await sessionRequest("/public/sessions/"+encodeURIComponent(sessionId)+"/pair-code",{method:"POST",body:JSON.stringify({phone})});el("code").textContent=d.pairingCode;el("codeStatus").textContent="On your phone: WhatsApp → Linked devices → Link with phone number instead.";}catch(e){el("error").textContent=e.message;el("codeStatus").textContent="";}finally{busy=false;el("startCode").disabled=false;}};
  </script>`;
  res.type("html").send(page("Connect WhatsApp | YVONNIE2005", body));
});

/* FULL FAQ PAGE */
app.get("/faq", (_req, res) => {
  const body = `${nav()}<main class="wrap"><header class="portalhead"><div class="mascotmini">${robot}</div><span class="eyebrow">Help centre</span><h1>Setup guide & <span class="gradient">FAQ</span></h1><p>Follow the steps below to connect your account and solve common pairing problems.</p></header>
  <section class="section"><div class="sectionhead"><h2>QR code connection</h2><p>Use this method when you can scan a QR code with your phone.</p></div><div class="steps"><div class="step"><b>01</b><h3>Open the portal</h3><p>Go to the <a href="/connect">connection page</a> and select QR Code.</p></div><div class="step"><b>02</b><h3>Generate the code</h3><p>Tap Generate QR Code and wait for the image to appear.</p></div><div class="step"><b>03</b><h3>Scan in WhatsApp</h3><p>Open WhatsApp → Linked devices → Link a device, then scan the displayed code.</p></div></div></section>
  <section class="section"><div class="sectionhead"><h2>Phone-number pairing</h2><p>Use this if you prefer to enter a short code instead of scanning.</p></div><div class="card"><ol style="color:var(--muted);line-height:2"><li>Open <a href="/connect">the connection portal</a> and select Pairing Code.</li><li>Enter your phone number with country code. For Uganda, begin with 256.</li><li>Tap Generate pairing code.</li><li>On WhatsApp, open Linked devices → Link with phone number instead.</li><li>Enter the code shown on the portal and wait for confirmation.</li></ol></div></section>
  <section class="section"><div class="sectionhead"><h2>Frequently asked questions</h2><p>Answers to common setup and account questions.</p></div><div class="faq">
  <details open><summary>Why is my QR code not appearing?</summary><p>The WhatsApp worker may still be initializing. Wait briefly. If the portal reports an error or the session ends, start a new session. If it keeps failing, the hosting logs should be checked.</p></details>
  <details><summary>Why does the portal say the session expired?</summary><p>Uncompleted sessions expire after 15 minutes. Return to the connection page and generate a new QR or pairing code.</p></details>
  <details><summary>What does “too many attempts” mean?</summary><p>The portal limits repeated connection requests from the same IP address. Wait for the rate-limit window to pass before trying again.</p></details>
  <details><summary>My pairing code was rejected. What can I do?</summary><p>Check the country code and phone number, make sure you selected Link with phone number instead in WhatsApp, and create a fresh session before trying again.</p></details>
  <details><summary>Can I connect another person's WhatsApp?</summary><p>Only connect an account you own or have explicit permission to manage. Never request or use someone else's code without their consent.</p></details>
  <details><summary>Does my phone need to stay connected?</summary><p>The linked-device session must remain valid. WhatsApp may disconnect linked devices or require you to reconnect.</p></details>
  <details><summary>Where can I find bot commands?</summary><p>Try <b>.help</b> in a group where the bot is active. Only commands implemented and configured in the running bot will work; some advanced media and AI features need external providers.</p></details>
  <details><summary>Is the admin dashboard public?</summary><p>The admin API is protected by the API_TOKEN configured in your hosting environment. Never share that token or enter it on unofficial pages.</p></details>
  <details><summary>What should I do if the bot disconnects?</summary><p>Check the hosting service health and logs. If WhatsApp has logged out the linked device, use the connection portal to link it again.</p></details>
  <details><summary>Can I share my QR or pairing code?</summary><p>No. Treat them as private authentication credentials. Enter them only in your own WhatsApp application.</p></details>
  </div></section><section class="section"><div class="banner"><h2>Still need to connect?</h2><p>Return to the secure portal and start a fresh session.</p><a class="btn" href="/connect">Open connection portal →</a></div></section></main><footer class="footer">© ${new Date().getFullYear()} YVONNIE2005 · <a href="/">Home</a></footer>`;
  res.type("html").send(page("Help Centre & FAQ | YVONNIE2005", body));
});

/* ADMIN DASHBOARD */
app.get("/admin", (_req, res) => {
  const body = `${nav()}<main class="adminwrap"><header class="portalhead"><span class="eyebrow">Restricted access</span><h1>Admin <span class="gradient">Control Centre</span></h1><p>Private service monitoring for the YVONNIE2005 worker.</p></header>
  <section class="glass" id="login"><h2>Administrator sign in</h2><p class="muted">Enter the API_TOKEN configured in your hosting environment. It is never saved by this page.</p><input id="token" class="field" type="password" autocomplete="current-password" placeholder="Administrator API token"><button id="loginBtn" class="btn">Unlock dashboard →</button><p id="loginMessage" class="status" role="alert"></p></section>
  <div id="dashboard" style="display:none"><section class="glass"><div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap"><h2>System overview</h2><button id="refresh" class="btn alt">↻ Refresh</button></div><div class="stats"><div class="stat">Service status<strong id="health">—</strong></div><div class="stat">Worker accounts<strong id="accountsCount">—</strong></div><div class="stat">Pending sessions<strong id="sessionsCount">—</strong></div><div class="stat">Server time<strong id="serverTime">—</strong></div></div></section>
  <section class="glass"><h2>WhatsApp accounts</h2><p class="muted">Accounts currently active in this worker process.</p><div class="tablewrap"><table><thead><tr><th>Account ID</th><th>Status</th><th>Last error</th></tr></thead><tbody id="accountRows"><tr><td colspan="3">No data loaded.</td></tr></tbody></table></div></section>
  <section class="glass"><h2>Start an existing account</h2><p class="muted">Use only an account ID already managed by your system.</p><input id="accountId" class="field" placeholder="Account ID"><button id="connectAccount" class="btn">Start account</button><p id="actionMessage" class="status"></p></section>
  <section class="grid"><article class="card"><div class="ico">🌐</div><h3>Public portal</h3><p>Open the user-facing connection experience.</p><a href="/connect">Open portal →</a></article><article class="card"><div class="ico">📚</div><h3>Help centre</h3><p>Setup instructions and troubleshooting answers.</p><a href="/faq">Open FAQ →</a></article><article class="card"><div class="ico">💚</div><h3>Health endpoint</h3><p>Check the worker health response.</p><a href="/health">Open health →</a></article></section><p style="margin-top:20px"><button id="logout" class="btn alt">Lock dashboard</button></p></div></main>
  <script>
  const el=id=>document.getElementById(id);
  let token="";
  async function api(path,options={}){const r=await fetch(path,{...options,headers:{"Content-Type":"application/json","Authorization":"Bearer "+token,...(options.headers||{})}});const d=await r.json();if(!r.ok)throw new Error(d.error||"Request failed.");return d;}
  async function loadDashboard(){const [h,a]=await Promise.all([api("/api/health"),api("/api/accounts")]);el("health").textContent=h.status||"Unknown";el("accountsCount").textContent=h.activeAccounts??0;el("sessionsCount").textContent=h.pendingSessions??0;el("serverTime").textContent=new Date().toLocaleTimeString();const rows=a.accounts||[];el("accountRows").replaceChildren();if(!rows.length){const tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=3;td.textContent="No active accounts.";tr.appendChild(td);el("accountRows").appendChild(tr);return;}rows.forEach(a=>{const tr=document.createElement("tr");[a.id,a.status,a.error||"—"].forEach(v=>{const td=document.createElement("td");td.textContent=String(v);tr.appendChild(td);});el("accountRows").appendChild(tr);});}
  el("loginBtn").onclick=async()=>{token=el("token").value.trim();if(!token){el("loginMessage").textContent="Enter your admin token.";return;}try{await loadDashboard();el("login").style.display="none";el("dashboard").style.display="block";}catch(e){token="";el("loginMessage").textContent=e.message;}};
  el("refresh").onclick=async()=>{try{await loadDashboard();el("actionMessage").textContent="Updated.";}catch(e){el("actionMessage").textContent=e.message;}};
  el("connectAccount").onclick=async()=>{const id=el("accountId").value.trim();if(!id){el("actionMessage").textContent="Enter an account ID.";return;}try{const d=await api("/api/accounts/"+encodeURIComponent(id)+"/connect",{method:"POST"});el("actionMessage").textContent="Account started: "+d.status;await loadDashboard();}catch(e){el("actionMessage").textContent=e.message;}};
  el("logout").onclick=()=>{token="";el("token").value="";el("dashboard").style.display="none";el("login").style.display="block";};
  </script>`;
  res.type("html").send(page("Admin Control Centre | YVONNIE2005", body));
});

/* HEALTH */
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
    res.status(201).json(await createPublicSession());
  } catch (error) {
    console.error("Session creation failed:", error.message);
    res.status(503).json({ error: error.message || "Could not start WhatsApp session." });
  }
});

/* PUBLIC QR STATUS */
app.get("/public/sessions/:id/qr", sessionAuth, async (req, res) => {
  const account = accounts.get(req.params.id);
  if (!account) return res.status(410).json({ error: "WhatsApp session ended. Start again." });
  if (account.status === "connected") return res.json({ status: "connected", qr: null });
  if (["disconnected", "logged_out"].includes(account.status)) {
    return res.json({ status: account.status, qr: null, error: account.lastError });
  }
  if (!account.qr) return res.json({ status: account.status, qr: null });
  try {
    const qr = await QRCode.toDataURL(account.qr, { width: 300, margin: 1 });
    res.json({ status: account.status, qr });
  } catch (_) {
    res.status(500).json({ error: "QR generation failed." });
  }
});

/* PUBLIC PAIRING CODE */
app.post("/public/sessions/:id/pair-code", sessionAuth, async (req, res) => {
  const account = accounts.get(req.params.id);
  const phone = String(req.body.phone || "").replace(/\D/g, "");
  if (!account?.socket) return res.status(410).json({ error: "WhatsApp session ended. Start again." });
  if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: "Invalid international phone number." });
  if (account.status === "connected") return res.status(409).json({ error: "This WhatsApp account is already connected." });
  if (["disconnected", "logged_out"].includes(account.status)) {
    return res.status(410).json({ error: account.lastError || "WhatsApp session ended. Start again." });
  }
  try {
    await waitForSocketReady(account);
    if (account.status === "connected") return res.status(409).json({ error: "This WhatsApp account is already connected." });
    if (!account.pairingPromise) account.pairingPromise = account.socket.requestPairingCode(phone);
    const pairingCode = await account.pairingPromise;
    account.pairingCode = pairingCode;
    res.json({ success: true, pairingCode, status: account.status });
  } catch (error) {
    account.pairingPromise = null;
    account.pairingCode = null;
    console.error("Pairing code error:", error.message);
    res.status(503).json({ error: error.message || "Pairing code is not ready. Start a fresh session and try again." });
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
  res.json({ status: account.status, qr: account.qr, error: account.lastError });
});

app.post("/api/accounts/:id/pair-code", async (req, res) => {
  const account = accounts.get(req.params.id);
  const phone = String(req.body.phone || "").replace(/\D/g, "");
  if (!account?.socket) return res.status(404).json({ error: "Connect account first." });
  if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: "Invalid phone number." });
  if (account.status === "connected") return res.status(409).json({ error: "This account is already connected." });
  try {
    await waitForSocketReady(account);
    if (!account.pairingPromise) account.pairingPromise = account.socket.requestPairingCode(phone);
    const pairingCode = await account.pairingPromise;
    account.pairingCode = pairingCode;
    res.json({ success: true, pairingCode });
  } catch (error) {
    account.pairingPromise = null;
    account.pairingCode = null;
    res.status(503).json({ error: error.message || "Pairing code unavailable." });
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
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing.");
  if (!TOKEN) throw new Error("API_TOKEN is missing.");

  await initializeDatabase();

  await query(`CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
    account_id TEXT NOT NULL,
    key_type TEXT,
    key_id TEXT NOT NULL,
    key_data JSONB
  )`);

  await query(`ALTER TABLE whatsapp_auth_keys ADD COLUMN IF NOT EXISTS key_type TEXT`);
  await query(`UPDATE whatsapp_auth_keys SET key_type = 'legacy' WHERE key_type IS NULL`);
  await query(`ALTER TABLE whatsapp_auth_keys ALTER COLUMN key_type SET NOT NULL`);

  await query(`DO $$
    DECLARE pk_name TEXT;
    BEGIN
      SELECT conname INTO pk_name FROM pg_constraint
      WHERE conrelid = 'whatsapp_auth_keys'::regclass AND contype = 'p';
      IF pk_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE whatsapp_auth_keys DROP CONSTRAINT %I', pk_name);
      END IF;
      ALTER TABLE whatsapp_auth_keys ADD CONSTRAINT whatsapp_auth_keys_pkey
      PRIMARY KEY (account_id, key_type, key_id);
    END $$`);

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
