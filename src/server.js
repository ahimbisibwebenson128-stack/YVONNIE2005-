
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
  const token = (req.headers.authorization || "")
    .replace(/^Bearer\s+/i, "");

  if (!TOKEN || !safeEqual(token, TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function sessionAuth(req, res, next) {
  const session = sessions.get(req.params.id);
  const token = String(req.headers["x-session-token"] || "");

  if (!session || session.expiresAt < Date.now()) {
    return res.status(404).json({
      error: "Session expired. Start a new session."
    });
  }

  if (!safeEqual(token, session.token)) {
    return res.status(401).json({
      error: "Invalid session token."
    });
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
  if (accounts.has(id)) {
    return accounts.get(id);
  }

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

  // Register before creating the socket to avoid duplicate sessions.
  accounts.set(id, account);

  try {
    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["YVONNIE2005", "Chrome", "1.0.0"],
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
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

        const statusCode =
          update.lastDisconnect?.error?.output?.statusCode;

        const loggedOut =
          statusCode === DisconnectReason.loggedOut;

        account.status = loggedOut ? "logged_out" : "disconnected";
        account.lastError = loggedOut
          ? "WhatsApp logged out. Reconnect your account."
          : "WhatsApp connection closed. You can try reconnecting.";

        console.log(
          "WhatsApp connection closed:",
          id,
          statusCode || "unknown"
        );

        // Do not delete the account here.
        // Keeping its record allows the portal to report the real status.
        // The saved credentials remain in PostgreSQL.
        if (!account.intentionalClose && !loggedOut) {
          account.status = "disconnected";
        }
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

  // Connected accounts are not terminated by the pairing timer.
  if (account && account.status === "connected") {
    sessions.delete(id);
    return;
  }

  if (account && account.socket) {
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

  const session = {
    token,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL,
    connected: false
  };

  sessions.set(id, session);

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

app.get("/", (_req, res) => {
  res.json({
    name: "YVONNIE2005",
    status: "running",
    portal: "/connect"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    service: "YVONNIE2005",
    activeAccounts: accounts.size,
    pendingSessions: sessions.size
  });
});

/* PUBLIC CONNECTION PORTAL */

app.get("/connect", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#07130f">
<title>YVONNIE2005 | Connect</title>
<style>
*{box-sizing:border-box}
body{
 margin:0;min-height:100vh;padding:20px;
 display:grid;place-items:center;
 background:radial-gradient(circle at top,#17452e,#07130f 65%);
 color:#eef8f1;font-family:Arial,sans-serif
}
main{
 width:min(100%,520px);padding:26px;
 background:#10251c;border:1px solid #326044;
 border-radius:22px;box-shadow:0 20px 65px #0009
}
h1{color:#b8efc8;margin:0 0 8px;font-size:30px}
p{color:#bfd2c5;line-height:1.55}
.tabs{display:flex;gap:9px;margin:22px 0}
button{
 border:0;border-radius:11px;padding:14px;
 background:#b8efc8;color:#10251c;
 font-weight:bold;cursor:pointer
}
button:disabled{opacity:.55;cursor:wait}
.tabs button{flex:1;background:#1d3b2c;color:white}
.tabs button.active{background:#b8efc8;color:#10251c}
input{
 width:100%;padding:15px;border-radius:10px;
 border:1px solid #456c54;background:#08170f;
 color:white;margin:10px 0 14px;font-size:16px
}
.panel{display:none}
.panel.active{display:block}
.result{text-align:center;margin-top:17px;overflow-wrap:anywhere}
#qr{
 width:250px;height:250px;background:white;
 padding:8px;border-radius:12px;
 display:none;margin:15px auto
}
#code{font-size:28px;letter-spacing:3px;font-weight:bold;color:#b8efc8}
.small{font-size:12px;color:#9eb8a6}
.error{color:#ffb4a9}
.status{min-height:25px}
</style>
</head>
<body>
<main>
<h1>YVONNIE2005</h1>
<p>Connect your WhatsApp account to the multi-device bot.</p>

<div class="tabs">
<button id="qrTab" class="active">QR CODE</button>
<button id="codeTab">PAIRING CODE</button>
</div>

<div id="qrPanel" class="panel active">
<p>Open WhatsApp → Linked devices → Link a device.</p>
<button id="startQr">Generate QR Code</button>
<div class="result">
<img id="qr" alt="WhatsApp connection QR code">
<p id="qrStatus" class="status"></p>
</div>
</div>

<div id="codePanel" class="panel">
<p>Enter your WhatsApp number with country code.</p>
<input id="phone" inputmode="numeric" placeholder="2567XXXXXXXX">
<button id="startCode">Get Pairing Code</button>
<div class="result">
<div id="code"></div>
<p id="codeStatus" class="status"></p>
</div>
</div>

<p class="small">
Pairing sessions expire after 15 minutes if not connected.
Never share your QR code or pairing code. Only connect an account
you own or are authorized to use.
</p>
<p id="error" class="error"></p>
</main>

<script>
let sessionId=null;
let sessionToken=null;
let poller=null;
let busy=false;

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
 if(sessionId && sessionToken) return;

 const response=await fetch("/public/sessions",{method:"POST"});
 const data=await response.json();

 if(!response.ok) throw new Error(data.error||"Could not start session");

 sessionId=data.id;
 sessionToken=data.token;
}

async function sessionRequest(path,options={}){
 const response=await fetch(path,{
  ...options,
  headers:{
   "Content-Type":"application/json",
   "x-session-token":sessionToken,
   ...(options.headers||{})
  }
 });

 const data=await response.json();

 if(!response.ok){
  if(response.status===404||response.status===410){
   sessionId=null;
   sessionToken=null;
  }
  throw new Error(data.error||"Request failed");
 }

 return data;
}

function stopPolling(){
 if(poller){
  clearInterval(poller);
  poller=null;
 }
}

async function pollQR(){
 try{
  const data=await sessionRequest(
   "/public/sessions/"+sessionId+"/qr"
  );

  if(data.qr){
   el("qr").src=data.qr;
   el("qr").style.display="block";
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
   stopPolling();
   sessionId=null;
   sessionToken=null;
  }
 }catch(error){
  el("qrStatus").textContent=error.message;
  stopPolling();
 }
}

el("startQr").onclick=async()=>{
 if(busy)return;
 busy=true;
 el("startQr").disabled=true;
 el("error").textContent="";
 el("qr").style.display="none";

 try{
  stopPolling();
  sessionId=null;
  sessionToken=null;
  await createSession();

  el("qrStatus").textContent="Waiting for WhatsApp QR code...";
  await pollQR();
  if(sessionId) poller=setInterval(pollQR,2500);
 }catch(error){
  el("error").textContent=error.message;
 }finally{
  busy=false;
  el("startQr").disabled=false;
 }
};

el("startCode").onclick=async()=>{
 if(busy)return;
 busy=true;
 el("startCode").disabled=true;
 el("error").textContent="";
 el("code").textContent="";

 try{
  stopPolling();
  sessionId=null;
  sessionToken=null;

  const phone=el("phone").value.replace(/\\D/g,"");
  if(phone.length<8||phone.length>15){
   throw new Error("Enter a valid international phone number.");
  }

  await createSession();
  el("codeStatus").textContent="Requesting pairing code...";

  let data=null;
  let lastError=null;

  for(let attempt=0;attempt<5;attempt++){
   try{
    data=await sessionRequest(
     "/public/sessions/"+sessionId+"/pair-code",
     {
      method:"POST",
      body:JSON.stringify({phone})
     }
    );
    break;
   }catch(error){
    lastError=error;
    if(attempt<4){
     await new Promise(resolve=>setTimeout(resolve,2500));
    }
   }
  }

  if(!data)throw lastError||new Error("Pairing code unavailable.");

  el("code").textContent=data.pairingCode;
  el("codeStatus").textContent=
   "WhatsApp → Linked devices → Link with phone number.";
 }catch(error){
  el("error").textContent=error.message;
  el("codeStatus").textContent="";
 }finally{
  busy=false;
  el("startCode").disabled=false;
 }
};
</script>
</body>
</html>`);
});

/* CREATE PUBLIC SESSION */

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

/* SESSION STATUS */

app.get("/public/sessions/:id/qr", sessionAuth, async (req, res) => {
  const account = accounts.get(req.params.id);

  if (!account) {
    return res.status(410).json({
      error: "WhatsApp session ended. Start again."
    });
  }

  if (account.status === "connected") {
    return res.json({ status: "connected", qr: null });
  }

  if (account.status === "disconnected" ||
      account.status === "logged_out") {
    return res.json({
      status: account.status,
      qr: null,
      error: account.lastError
    });
  }

  if (!account.qr) {
    return res.json({
      status: account.status,
      qr: null
    });
  }

  try {
    const qr = await QRCode.toDataURL(account.qr, {
      width: 280,
      margin: 1
    });

    res.json({
      status: account.status,
      qr
    });
  } catch (error) {
    res.status(500).json({ error: "QR generation failed." });
  }
});

/* PAIRING CODE */

app.post(
  "/public/sessions/:id/pair-code",
  sessionAuth,
  async (req, res) => {
    const account = accounts.get(req.params.id);
    const phone = String(req.body.phone || "").replace(/\D/g, "");

    if (!account || !account.socket) {
      return res.status(410).json({
        error: "WhatsApp session ended. Start again."
      });
    }

    if (phone.length < 8 || phone.length > 15) {
      return res.status(400).json({
        error: "Invalid international phone number."
      });
    }

    if (account.status === "connected") {
      return res.status(409).json({
        error: "This WhatsApp account is already connected."
      });
    }

    if (account.pairingCode) {
      return res.json({
        success: true,
        pairingCode: account.pairingCode
      });
    }

    try {
      if (!account.pairingPromise) {
        account.pairingPromise =
          account.socket.requestPairingCode(phone);
      }

      const pairingCode = await account.pairingPromise;
      account.pairingCode = pairingCode;

      res.json({
        success: true,
        pairingCode
      });
    } catch (error) {
      account.pairingPromise = null;
      console.error("Pairing code error:", error.message);

      res.status(503).json({
        error: "Pairing code is not ready. Wait a few seconds and try again."
      });
    }
  }
);

/* PRIVATE ADMIN API */

app.use("/api", apiAuth);

app.post("/api/accounts/:id/connect", async (req, res) => {
  const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, "");

  if (!id) {
    return res.status(400).json({ error: "Invalid account ID." });
  }

  try {
    const account = await startAccount(id);

    res.json({
      success: true,
      account: id,
      status: account.status
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/accounts/:id/qr", (req, res) => {
  const account = accounts.get(req.params.id);

  if (!account) {
    return res.status(404).json({ error: "Account not started." });
  }

  res.json({
    status: account.status,
    qr: account.qr,
    error: account.lastError
  });
});

app.post("/api/accounts/:id/pair-code", async (req, res) => {
  const account = accounts.get(req.params.id);
  const phone = String(req.body.phone || "").replace(/\D/g, "");

  if (!account || !account.socket) {
    return res.status(404).json({
      error: "Connect account first."
    });
  }

  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({
      error: "Invalid phone number."
    });
  }

  try {
    if (!account.pairingCode) {
      if (!account.pairingPromise) {
        account.pairingPromise =
          account.socket.requestPairingCode(phone);
      }

      account.pairingCode = await account.pairingPromise;
    }

    res.json({
      success: true,
      pairingCode: account.pairingCode
    });
  } catch (error) {
    account.pairingPromise = null;
    res.status(503).json({
      error: "Pairing code unavailable. Try again shortly."
    });
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

/* DATABASE INITIALIZATION AND SERVER */

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
    console.log("Connection portal: /connect");
  });
}

start().catch(error => {
  console.error("Startup failed:", error);
  process.exit(1);
});
