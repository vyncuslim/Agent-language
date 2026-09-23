#!/usr/bin/env node
/**
 * VAML LAN test chat — one-file chat room for the whole LAN (testing only).
 *
 * Zero dependencies, plain Node 20+. Run on one machine, everyone on the
 * LAN opens the printed URL in a browser. Messages live in memory only
 * (last 200), nothing is persisted, nothing is encrypted — this is a
 * connectivity/UX test tool, NOT a secure channel.
 *
 * Usage:
 *   node tools/lan-chat-server.mjs [port]
 *   npm run chat:lan -- 8787
 */
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";

const PORT = Number(process.argv[2] || process.env.LAN_CHAT_PORT || 8787);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) {
  console.error("Port must be an integer 1024-65535");
  process.exit(1);
}
const MAX_MESSAGES = 200;
const MAX_NAME = 32;
const MAX_TEXT = 2000;
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 10;

const messages = [];
let nextId = 1;
const sseClients = new Set();
const rateMap = new Map();

function lanUrls(port) {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const nic of list || []) {
      if (nic.family === "IPv4" && !nic.internal) out.push(`http://${nic.address}:${port}`);
    }
  }
  return out.length ? out : [`http://localhost:${port}`];
}

function broadcast(message) {
  const data = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function checkRate(ip) {
  const now = Date.now();
  const hits = (rateMap.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  rateMap.set(ip, hits);
  return hits.length <= RATE_MAX;
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>VAML LAN Test Chat</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
body{margin:0;background:#0b0f14;color:#e6edf3}
main{max-width:760px;margin:auto;padding:20px 16px 40px}
h1{font-size:20px}
.hint{color:#93a4b6;font-size:13px}
#log{border:1px solid #27303a;border-radius:10px;background:#111820;height:52vh;overflow-y:auto;padding:12px;margin:12px 0}
.msg{margin:8px 0;line-height:1.5;overflow-wrap:anywhere}
.meta{color:#93a4b6;font-size:12px}
.me{color:#3fb950}.sys{color:#d29922}
.row{display:flex;gap:8px}
input,button{padding:10px 12px;border-radius:8px;border:1px solid #27303a;background:#0d1b2a;color:#e6edf3;font-size:15px}
#name{width:110px;flex:none}
#text{flex:1}
button{background:#e6edf3;color:#0b0f14;font-weight:700;cursor:pointer;border:0}
button:disabled{opacity:.5}
</style>
</head>
<body><main>
<h1>VAML 局域网测试聊天室</h1>
<p class="hint">仅用于局域网联调测试：消息只保存在服务器内存（最近 200 条），不加密、不落盘。请勿发送敏感内容。</p>
<div id="log" aria-live="polite"></div>
<div class="row"><input id="name" maxlength="32" placeholder="昵称" autocomplete="off" /><input id="text" maxlength="2000" placeholder="输入消息，回车发送" autocomplete="off" /><button id="send">发送</button></div>
<p class="hint" id="count"></p>
<script>
(()=>{"use strict";
const log=document.getElementById("log"),nameEl=document.getElementById("name"),textEl=document.getElementById("text"),sendBtn=document.getElementById("send"),countEl=document.getElementById("count");
let lastId=0;
const esc=s=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function add(m){lastId=Math.max(lastId,m.id);const d=document.createElement("div");d.className="msg";const t=new Date(m.at).toLocaleTimeString();d.innerHTML='<span class="meta">['+t+'] <b>'+esc(m.user)+'</b></span><br>'+esc(m.text);log.appendChild(d);while(log.children.length>200)log.removeChild(log.firstChild);log.scrollTop=log.scrollHeight;countEl.textContent='在线消息 '+log.children.length+' 条（服务器共保留最近 200 条）'}
async function load(){try{const r=await fetch("/api/messages?since="+lastId);if(!r.ok)return;for(const m of await r.json())add(m)}catch{}}
async function send(){const user=nameEl.value.trim().slice(0,32)||"匿名",text=textEl.value.trim().slice(0,2000);if(!text)return;sendBtn.disabled=true;try{const r=await fetch("/api/send",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({user,text})});if(!r.ok)alert("发送失败："+r.status);else textEl.value=""}catch{alert("网络错误")}finally{sendBtn.disabled=false;textEl.focus()}}
sendBtn.addEventListener("click",send);
textEl.addEventListener("keydown",e=>{if(e.key==="Enter")send()});
try{nameEl.value=localStorage.getItem("lan-chat-name")||""}catch{}
nameEl.addEventListener("change",()=>{try{localStorage.setItem("lan-chat-name",nameEl.value)}catch{}});
load();
try{const es=new EventSource("/api/events");es.onmessage=e=>{try{add(JSON.parse(e.data))}catch{}};es.onerror=()=>{setTimeout(load,3000)}}catch{setInterval(load,3000)}
})();
</script>
</main></body></html>`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://lan");
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/messages") {
      const since = Number(url.searchParams.get("since") || 0);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(messages.filter((m) => m.id > since)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/send") {
      const ip = req.socket.remoteAddress || "unknown";
      if (!checkRate(ip)) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Too many messages, slow down" }));
        return;
      }
      let body;
      try {
        body = JSON.parse(await readBody(req, 8192));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      const user = typeof body.user === "string" ? body.user.trim().slice(0, MAX_NAME) || "匿名" : "匿名";
      const text = typeof body.text === "string" ? body.text.trim().slice(0, MAX_TEXT) : "";
      if (!text) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Empty message" }));
        return;
      }
      const message = { id: nextId++, user, text, at: new Date().toISOString() };
      messages.push(message);
      while (messages.length > MAX_MESSAGES) messages.shift();
      broadcast(message);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: message.id }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch {
    try {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Server error" }));
    } catch {
      // socket already gone
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("VAML LAN test chat running (testing only, no encryption):");
  for (const url of lanUrls(PORT)) console.log(`  ${url}`);
  console.log("Everyone on the LAN: open the URL above in a browser.");
});
