import fs from "fs";
import path from "path";
import ws3 from "ws3-fca";
import express from "express";
import http from "http";
import https from "https";

const login = typeof ws3 === "function" ? ws3 : (ws3.default || ws3.login || ws3);

// ----- Get admin UID arg -----
const ADMIN_ARG = process.argv[2];
if (!ADMIN_ARG) {
  console.error("❌ Missing admin UID arg. Usage: node bot.js <adminUID>");
  process.exit(1);
}

const ROOT = process.cwd();
const USER_DIR = path.join(ROOT, "users", String(ADMIN_ARG));
const APPSTATE_PATH = path.join(USER_DIR, "appstate.json");
const ADMIN_PATH = path.join(USER_DIR, "admin.txt");
const LOCKS_PATH = path.join(USER_DIR, "locks.json");
const PHOTOS_DIR = path.join(USER_DIR, "photos");

if (!fs.existsSync(USER_DIR)) {
  console.error("❌ User folder not found:", USER_DIR);
  process.exit(1);
}
if (!fs.existsSync(PHOTOS_DIR)) {
  try { fs.mkdirSync(PHOTOS_DIR, { recursive: true }); } catch (e) {}
}

// ----- Load appstate -----
let appState;
try {
  appState = JSON.parse(fs.readFileSync(APPSTATE_PATH, "utf8"));
} catch (e) {
  console.error("❌ Failed reading appstate.json:", e.message);
  process.exit(1);
}

// ----- Boss UID -----
let BOSS_UID = ADMIN_ARG;
try {
  if (fs.existsSync(ADMIN_PATH)) {
    const t = fs.readFileSync(ADMIN_PATH, "utf8").trim();
    if (t) BOSS_UID = t;
  }
} catch {}

// ----- Locks -----
let locks = {
  groupNames: {},
  nicknames: {},
  emojis: {},
  antiOut: {},
  groupPics: {}
};
try {
  if (fs.existsSync(LOCKS_PATH)) locks = JSON.parse(fs.readFileSync(LOCKS_PATH, "utf8"));
} catch (e) {
  console.warn("⚠️ Could not load locks.json, using defaults.");
}

function saveLocks() {
  try {
    fs.writeFileSync(LOCKS_PATH, JSON.stringify(locks, null, 2));
  } catch (e) {
    console.error("❌ Failed saving locks:", e.message);
  }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ----- Helper: Download File -----
function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    try {
      const lib = url.startsWith("https") ? https : http;
      const req = lib.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return downloadToFile(res.headers.location, dest).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) return reject(new Error("Download failed, status " + res.statusCode));
        const fileStream = fs.createWriteStream(dest);
        res.pipe(fileStream);
        fileStream.on("finish", () => fileStream.close(() => resolve(dest)));
        fileStream.on("error", (err) => reject(err));
      });
      req.on("error", (err) => reject(err));
    } catch (e) { reject(e); }
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ----- Nickname Queue -----
const nickQueue = [];
let nickProcessing = false;
const NICK_DELAY_MS = 700;

function enqueueNickTask(fn) {
  return new Promise(resolve => {
    nickQueue.push({ fn, resolve });
    if (!nickProcessing) processNickQueue();
  });
}

async function processNickQueue() {
  nickProcessing = true;
  while (nickQueue.length) {
    const item = nickQueue.shift();
    try { await item.fn(); } catch (e) { log('❌ nick task failed: ' + e.message); }
    try { item.resolve(); } catch {}
    await sleep(NICK_DELAY_MS);
  }
  nickProcessing = false;
}

async function retryChangeNick(api, threadID, uid, nick, retries = 3) {
  let lastErr = null;
  await enqueueNickTask(async () => {
    for (let i = 0; i < retries; i++) {
      try {
        lastErr = null;
        await new Promise(res => api.changeNickname(nick, threadID, uid, err => { lastErr = err; res(); }));
        if (!lastErr) return;
      } catch (e) { lastErr = e; }
      await sleep(250 + i * 200);
    }
  });
  if (lastErr) { log(`❌ changeNickname failed for ${uid}`); return false; }
  return true;
}

async function revertSingleNick(api, threadID, uid) {
  const locked = locks.nicknames?.[threadID]?.[uid];
  if (!locked) return;
  await retryChangeNick(api, threadID, uid, locked, 3);
  log(`🔁 Reverted nick for ${uid} in ${threadID}`);
}

async function enforceNickLockForThread(api, threadID, nick) {
  const info = await api.getThreadInfo(threadID);
  const members = info?.participantIDs || [];
  for (const uid of members) await retryChangeNick(api, threadID, uid, nick, 3);
  locks.nicknames[threadID] = {};
  members.forEach(uid => { locks.nicknames[threadID][uid] = nick; });
  saveLocks();
  log(`🔐 Nicklock enforced for ${threadID}`);
  return true;
}

// ----- Keepalive -----
try {
  const app = express();
  app.get("/", (req, res) => res.send("OK"));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => log(`🌐 Keepalive on ${PORT}`));
} catch (e) {
  log("⚠️ Keepalive failed: " + e.message);
}

process.on("uncaughtException", e => log("⛔ uncaughtException: " + e.message));
process.on("unhandledRejection", e => log("⛔ unhandledRejection: " + e.message));

// ----- Login -----
login({ appState }, async (err, api) => {
  if (err) {
    console.error("❌ Login failed:", err);
    process.exit(1);
  }

  api.setOptions({ listenEvents: true, selfListen: true });
  log("🤖 Bot logged in. Listening...");

  setInterval(saveLocks, 60 * 1000);

  api.listenMqtt(async (err, event) => {
    if (err || !event) return;

    try {
      const threadID = String(event.threadID || "");
      const senderID = String(event.senderID || "");
      const body = (event.body || "").toString();
      const logType = event.logMessageType || "";

      // ---------- EVENTS ----------
      if (event.type === "event") {
        // Name change
        if (logType === "log:thread-name") {
          const newName = event.logMessageData?.name || "";
          const lockedName = locks.groupNames?.[threadID];
          if (lockedName && newName !== lockedName)
            try { await api.setTitle(lockedName, threadID); log(`🔒 Reverted name in ${threadID}`); } catch {}
          return;
        }

        // Group picture change
        if (["log:thread-image", "log:thread-photo", "log:thread-image-update"].includes(logType)) {
          const locked = locks.groupPics?.[threadID];
          if (locked && locked.file && fs.existsSync(locked.file)) {
            try {
              await api.changeGroupImage(locked.file, threadID);
              await api.sendMessage("📸 Group picture reverted (lock active).", threadID);
              log(`🔒 Reverted photo in ${threadID}`);
            } catch (e) { log("❌ revert group pic: " + e.message); }
          }
          return;
        }

        // Nick change
        if (["log:user-nickname"].includes(logType)) {
          const uid = event.logMessageData?.participant_id;
          const newNick = event.logMessageData?.nickname;
          if (locks.nicknames?.[threadID]?.[uid] && locks.nicknames[threadID][uid] !== newNick)
            await revertSingleNick(api, threadID, uid);
          return;
        }
      }

      // ---------- COMMANDS ----------
      if (senderID !== BOSS_UID) return;
      if (!body) return;

      const parts = body.trim().split(/\s+/);
      const cmd = parts[0].replace(/^\//, "").toLowerCase();
      const args = parts.slice(1);

      // /anurag (help)
      if (cmd === "anurag") {
        const help = `
👑 *ANURAG BOT COMMANDS LIST* 👑

/groupname on <name> → Lock group name  
/groupname off → Unlock group name  

/nicknames on <nick> → Lock all nicknames  
/nicknames off → Unlock nicknames  

/photolock on → Lock current group photo  
/photolock off → Unlock group photo  
/photolock reset → Restore locked photo  

🧠 Only admin UID: ${BOSS_UID}
🔰 Powered by: *Anurag Mishra*
        `.trim();
        return api.sendMessage(help, threadID);
      }

      // /groupname
      if (cmd === "groupname") {
        const sub = (args[0] || "").toLowerCase();
        if (sub === "on") {
          const name = args.slice(1).join(" ");
          if (!name) return api.sendMessage("⚠️ Usage: /groupname on <Name>", threadID);
          locks.groupNames[threadID] = name;
          saveLocks();
          await api.setTitle(name, threadID);
          return api.sendMessage(`✅ Group name locked: ${name}`, threadID);
        }
        if (sub === "off") {
          delete locks.groupNames[threadID];
          saveLocks();
          return api.sendMessage("🔓 Group name unlocked", threadID);
        }
      }

      // /nicknames
      if (cmd === "nicknames") {
        const sub = (args[0] || "").toLowerCase();
        if (sub === "on") {
          const nick = args.slice(1).join(" ");
          if (!nick) return api.sendMessage("⚠️ Usage: /nicknames on <Nick>", threadID);
          await enforceNickLockForThread(api, threadID, nick);
          return api.sendMessage(`🔐 Nicknames locked as "${nick}"`, threadID);
        }
        if (sub === "off") {
          const existed = locks.nicknames[threadID];
          if (existed) {
            for (const uid of Object.keys(existed)) await retryChangeNick(api, threadID, uid, "", 3);
            delete locks.nicknames[threadID];
            saveLocks();
          }
          return api.sendMessage("🔓 Nicknames unlocked", threadID);
        }
      }

      // /photolock
      if (cmd === "photolock") {
        const sub = (args[0] || "").toLowerCase();

        const fetchThreadImageUrl = async () => {
          try {
            const info = await api.getThreadInfo(threadID);
            return info?.imageSrc || info?.threadImage || info?.image || "";
          } catch { return ""; }
        };

        if (sub === "on") {
          const url = await fetchThreadImageUrl();
          if (!url) return api.sendMessage("⚠️ No group photo found.", threadID);
          const extMatch = url.match(/\.(jpg|jpeg|png|webp)$/i);
          const ext = extMatch ? extMatch[1] : "jpg";
          const filename = path.join(PHOTOS_DIR, `${threadID}.${ext}`);
          try {
            await downloadToFile(url, filename);
            locks.groupPics[threadID] = { file: filename, url };
            saveLocks();
            await api.sendMessage("📸 Group photo locked successfully.", threadID);
          } catch (e) {
            log("❌ download error: " + e.message);
            await api.sendMessage("❌ Failed to save group photo.", threadID);
          }
          return;
        }

        if (sub === "off") {
          delete locks.groupPics[threadID];
          saveLocks();
          return api.sendMessage("🔓 Group photo unlocked.", threadID);
        }

        if (sub === "reset") {
          const locked = locks.groupPics?.[threadID];
          if (locked?.file && fs.existsSync(locked.file)) {
            await api.changeGroupImage(locked.file, threadID);
            return api.sendMessage("🔁 Group photo reset to locked image.", threadID);
          } else return api.sendMessage("⚠️ No saved image found.", threadID);
        }

        const has = locks.groupPics?.[threadID] ? "ON" : "OFF";
        return api.sendMessage(`📸 Photo lock is ${has}`, threadID);
      }

    } catch (e) {
      log("❌ Handler error: " + e.message);
    }
  });
});
