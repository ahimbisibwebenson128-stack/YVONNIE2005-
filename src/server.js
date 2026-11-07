
require("dotenv").config();

const express = require("express");
const pino = require("pino");
const crypto = require("crypto");
const QRCode = require("qrcode");
const makeWASocket = require("@whiskeysockets/baileys").default;
const { usePostgresAuthState } = require("./auth-state");
const { initializeDatabase, query } = require("./db");
const { attachGroupHandlers } = require("./group");

const app = express();
app.use(express.json({ limit: "1mb" }));

const accounts = new Map();
const sessions = new Map();
const ipAttempts = new Map();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.API_TOKEN;
const SESSION_TTL = 15 * 60 * 1000;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function apiAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!TOKEN || !safeEqual(token, TOKEN)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function sessionAuth(req, res, next) {
  const session = sessions.get(req.params.id);
  const token = String(req.headers["x-session-token"] || "");

  if (!session || session.expiresAt < Date.now()) {
    return res.status(404).json({ error: "Session expired. Start again." });
  }

  if (!safeEqual(token, session.token)) {
    return res.status(401).json({ error: "Invalid session token" });
  }

  next();
}

function rateLimit(req, res, next) {
  const ip = String(
    req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown"
  ).split(",")[0].trim();

  const now = Date.now();
  const attempts = (ipAttempts.get(ip) || []).filter(
    time => now - time < 3600000
  );

  if (attempts.length >= 8) {
    return res.status(429).json({
      error: "Too many attempts. Please try again later."
    });
  }

  attempts.push(now);
  ipAttempts.set(ip, attempts);
  next();
}

async function startAccount(id) {
  if (accounts.has(id)) return accounts.get(id);

  const { state, saveCreds } = await usePostgresAuthState(id);

  const socket = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: ["YVONNIE2005", "Chrome", "1.0.0"]
  });

  const account = {
    socket,
    qr: null,
    status: "connecting"
  };

  accounts.set(id, account);

  socket.ev.on("creds.update", saveCreds);
  attachGroupHandlers(socket);

  socket.ev.on("connection.update", update => {
    if (update.qr) account.qr = update.qr;

    if (update.connection === "open") {
      account.status = "connected";
      account.qr = null;
    }

    if (update.connection === "close") {
      account.status = "disconnected";
      accounts.delete(id);
    }
  });

  return account;
}

function endSession(id) {
  const session = sessions.get(id);
  if (!session) return;

  const account = accounts.get(id);

  if (account) {
    try {
      account.socket.end(new Error("Pairing session expired"));
    } catch (_) {}
    accounts.delete(id);
  }

  sessions.delete(id);
}

app.get("/", (_req, res) => {
  res.json({
    name: "YVONNIE2005",
    status: "running"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "healthy",
    service: "YVONNIE2005",
    activeAccounts: accounts.size
  });
});

/* PUBLIC CONNECTION PORTAL */

app.get("/connect", (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YVONNIE2005 Connection Portal</title>
<style>
*{box-sizing:border-box}
body{
 margin:0;background:#07130f;color:#eef8f1;
 font-family:Arial,sans-serif;min-height:100vh;
 display:grid;place-items:center;padding:18px
}
main{
 width:min(100%,520px);background:#10251c;
 border:1px solid #28533d;border-radius:20px;
 padding:24px;box-shadow:0 15px 50px #0008
}
h1{color:#b8efc8;margin-top:0}
p{color:#bfd2c5;line-height:1.5}
.tabs{display:flex;gap:8px;margin:20px 0}
button{
 border:0;border-radius:10px;padding:13px 16px;
 background:#b8efc8;color:#10251c;
 font-weight:bold;cursor:pointer
}
.tabs button{flex:1;background:#1d3b2c;color:white}
.tabs button.active{background:#b8efc8;color:#10251c}
input{
 width:100%;padding:14px;border-radius:10px;
 border:1px solid #456c54;background:#08170f;
 color:white;margin:8px 0 12px;font-size:16px
}
.panel{display:none}
.panel.active{display:block}
.result{text-align:center;margin-top:16px;overflow-wrap:anywhere}
#qr{
 width:240px;height:240px;background:white;
 padding:8px;border-radius:12px;
 display:none;margin:14px auto
}
#code{font-size:28px;letter-spacing:3px;font-weight:bold;color:#b8efc8}
.small{font-size:13px;color:#9eb8a6}
.error{color:#ffb4a9}
</style>
</head>
<body>
<main>
<h1>YVONNIE2005</h1>
<p>Connect your WhatsApp account to the bot.</p>

<div class="tabs">
<button id="qrTab" class="active">QR CODE</button>
<button id="codeTab">PAIRING CODE</button>
</div>

<div id="qrPanel" class="panel active">
<p>Generate a QR code and scan it using WhatsApp → Linked devices.</p>
<button id="startQr">Generate QR Code</button>
<div class="result">
<img id="qr" alt="WhatsApp QR code">
<p id="qrStatus"></p>
</div>
</div>

<div id="codePanel" class="panel">
<p>Enter your WhatsApp number with country code.</p>
<input id="phone" inputmode="numeric" placeholder="2567XXXXXXXX">
<button id="startCode">Get Pairing Code</button>
<div class="result">
<div id="code"></div>
<p id="codeStatus"></p>
</div>
</div>

<p class="small">
Pairing sessions expire after 15 minutes.
Never share your QR code or pairing code.
Only connect an account you own or are authorized to use.
</p>
<p id="error" class="error"></p>
</main>

<script>
let sessionId = null;
let sessionToken = null;
let poller = null;

const el = id => document.getElementById(id);

function showTab(tab) {
 el("qrPanel").classList.toggle("active",tab==="qr");
 el("codePanel").classList.toggle("active",tab==="code");
 el("qrTab").classList.toggle("active",tab==="qr");
 el("codeTab").classList.toggle("active",tab==="code");
 el("error").textContent = "";
}

el("qrTab").onclick = () => showTab("qr");
el("codeTab").onclick = () => showTab("code");

async function createSession() {
 const response = await fetch("/public/sessions",{method:"POST"});
 const data = await response.json();

 if (!response.ok) {
  throw new Error(data.error || "Could not start session");
 }

 sessionId = data.id;
 sessionToken = data.token;
}

async function sessionRequest(path,options={}) {
 const response = await fetch(path,{
  ...options,
  headers:{
   "Content-Type":"application/json",
   "x-session-token":sessionToken,
   ...(options.headers || {})
  }
 });

 const data = await response.json();

 if (!response.ok) {
  throw new Error(data.error || "Request failed");
 }

 return data;
}

el("startQr").onclick = async () => {
 el("startQr").disabled = true;
 el("error").textContent = "";
 el("qr").style.display = "none";

 try {
  await createSession();

  el("qrStatus").textContent = "Waiting for WhatsApp QR code...";

  if (poller) clearInterval(poller);

  poller = setInterval(async () => {
   try {
    const data = await sessionRequest(
     "/public/sessions/"+sessionId+"/qr"
    );

    if (data.qr) {
     el("qr").src = data.qr;
     el("qr").style.display = "block";
     el("qrStatus").textContent =
      "Scan using WhatsApp → Linked devices.";
    }

    if (data.status === "connected") {
     el("qr").style.display = "none";
     el("qrStatus").textContent =
      "WhatsApp connected successfully!";
     clearInterval(poller);
    }
   } catch (error) {
    el("qrStatus").textContent = error.message;
    clearInterval(poller);
   }
  },2000);

 } catch (error) {
  el("error").textContent = error.message;
 } finally {
  el("startQr").disabled = false;
 }
};

el("startCode").onclick = async () => {
 el("startCode").disabled = true;
 el("error").textContent = "";
 el("code").textContent = "";

 try {
  const phone = el("phone").value.replace(/\\D/g,"");

  if (phone.length < 8 || phone.length > 15) {
   throw new Error("Enter a valid international phone number.");
  }

  await createSession();

  el("codeStatus").textContent = "Requesting pairing code...";

  const data = await sessionRequest(
   "/public/sessions/"+sessionId+"/pair-code",
   {
    method:"POST",
    body:JSON.stringify({phone})
   }
  );

  el("code").textContent = data.pairingCode;
  el("codeStatus").textContent =
   "WhatsApp → Linked devices → Link with phone number.";

 } catch (error) {
  el("error").textContent = error.message;
  el("codeStatus").textContent = "";
 } finally {
  el("startCode").disabled = false;
 }
};
</script>
</body>
</html>`);
});

/* PUBLIC SESSION CREATION */

app.post("/public/sessions", rateLimit, async (_req, res) => {
 try {
  if (sessions.size >= 25) {
   return res.status(503).json({
    error: "Portal is busy. Try again shortly."
   });
  }

  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");

  sessions.set(id,{
   token,
   expiresAt:Date.now()+SESSION_TTL
  });

  try {
   await startAccount(id);
  } catch (error) {
   sessions.delete(id);
   throw error;
  }

  const timer = setTimeout(() => endSession(id),SESSION_TTL);
  if (timer.unref) timer.unref();

  res.status(201).json({id,token});

 } catch (error) {
  console.error("Public session error:",error.message);
  res.status(500).json({
   error:"Could not start WhatsApp session."
  });
 }
});

/* QR CODE */

app.get("/public/sessions/:id/qr",sessionAuth,(req,res) => {
 const account = accounts.get(req.params.id);

 if (!account) {
  return res.status(410).json({
   error:"WhatsApp session ended. Start again."
  });
 }

 if (account.status === "connected") {
  return res.json({status:"connected",qr:null});
 }

 if (!account.qr) {
  return res.json({status:account.status,qr:null});
 }

 QRCode.toDataURL(account.qr,{width:280,margin:1})
  .then(qr => res.json({status:account.status,qr}))
  .catch(() => res.status(500).json({
   error:"QR generation failed."
  }));
});

/* PHONE NUMBER PAIRING */

app.post("/public/sessions/:id/pair-code",sessionAuth,async (req,res) => {
 const account = accounts.get(req.params.id);
 const phone = String(req.body.phone || "").replace(/\D/g,"");

 if (!account) {
  return res.status(410).json({
   error:"WhatsApp session ended. Start again."
  });
 }

 if (phone.length < 8 || phone.length > 15) {
  return res.status(400).json({
   error:"Invalid phone number."
  });
 }

 try {
  const pairingCode = await account.socket.requestPairingCode(phone);
  res.json({success:true,pairingCode});
 } catch (error) {
  res.status(503).json({
   error:"Pairing code not ready. Wait a few seconds and try again."
  });
 }
});

/* EXISTING PRIVATE API */

app.use("/api",apiAuth);

app.post("/api/accounts/:id/connect",async (req,res) => {
 const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g,"");

 if (!id) {
  return res.status(400).json({error:"Invalid account ID"});
 }

 if (accounts.has(id)) {
  return res.json({success:true,message:"Already started"});
 }

 try {
  await startAccount(id);
  res.json({success:true,account:id,status:"connecting"});
 } catch (error) {
  res.status(500).json({error:error.message});
 }
});

app.get("/api/accounts/:id/qr",(req,res) => {
 const account = accounts.get(req.params.id);

 if (!account) {
  return res.status(404).json({error:"Account not started"});
 }

 res.json({
  status:account.status,
  qr:account.qr
 });
});

app.post("/api/accounts/:id/pair-code",async (req,res) => {
 const account = accounts.get(req.params.id);
 const phone = String(req.body.phone || "").replace(/\D/g,"");

 if (!account) {
  return res.status(404).json({error:"Connect account first"});
 }

 if (!phone) {
  return res.status(400).json({error:"Phone number required"});
 }

 try {
  const pairingCode = await account.socket.requestPairingCode(phone);
  res.json({success:true,pairingCode});
 } catch (error) {
  res.status(500).json({error:error.message});
 }
});

app.get("/api/accounts",(req,res) => {
 res.json({
  accounts:[...accounts.entries()].map(([id,account]) => ({
   id,
   status:account.status
  }))
 });
});

/* DATABASE AND SERVER STARTUP */

async function start() {
 await initializeDatabase();

 await query(`
  CREATE TABLE IF NOT EXISTS whatsapp_auth_keys (
   account_id TEXT NOT NULL,
   key_id TEXT NOT NULL,
   key_data JSONB,
   PRIMARY KEY (account_id,key_id)
  )
 `);

 app.listen(PORT,() => {
  console.log("YVONNIE2005 running on port "+PORT);
 });
}

start().catch(error => {
 console.error("Startup failed:",error);
 process.exit(1);
});
