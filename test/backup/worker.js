// Worker + Durable Object — v3.2
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/create" && request.method === "POST") {
      const { singleUse = false, ttlSeconds = 900 } = await request.json().catch(() => ({}));
      const key = makeKey(6);
      const id = env.ROOMS.idFromName(key);
      const stub = env.ROOMS.get(id);
      const now = Date.now();
      const expiresAt = now + ttlSeconds * 1000;
      await stub.fetch("https://do/session/create", { method: "POST", body: JSON.stringify({ key, singleUse, expiresAt }) });
      const joinUrl = `${url.origin}/join.html?key=${encodeURIComponent(key)}`;
      return json({ ok: true, key, joinUrl, expiresAt, singleUse });
    }
    if (url.pathname === "/ws") {
      const key = url.searchParams.get("key") || "";
      if (!key) return new Response("Missing key", { status: 400 });
      const id = env.ROOMS.idFromName(key.toUpperCase());
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }
    if (url.pathname.startsWith("/api/status/")) {
      const key = url.pathname.split("/").pop().toUpperCase();
      const id = env.ROOMS.idFromName(key);
      const stub = env.ROOMS.get(id);
      return stub.fetch("https://do/session/status");
    }
    return env.ASSETS.fetch(request);
  }
};
export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.conns = new Map();
    this.meta = { key: null, lastText: "", singleUse: false, expiresAt: 0 };
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("meta");
      if (stored) this.meta = stored;
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      await this.handleSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/session/create" && request.method === "POST") {
      const { key, singleUse, expiresAt } = await request.json();
      this.meta.key = (key || "").toUpperCase();
      this.meta.singleUse = !!singleUse;
      this.meta.expiresAt = expiresAt;
      await this.state.storage.put("meta", this.meta, { expiration: Math.floor(expiresAt / 1000) });
      return json({ ok: true });
    }
    if (url.pathname === "/session/status") {
      const now = Date.now();
      if (!this.meta.key || now >= this.meta.expiresAt) {
        return json({ ok: false, error: "not_found_or_expired" }, 404);
      }
      return json({ ok: true, key: this.meta.key, hasText: !!this.meta.lastText, singleUse: this.meta.singleUse, expiresAt: this.meta.expiresAt });
    }
    return new Response("Not found", { status: 404 });
  }
  async handleSocket(ws) {
    ws.accept();
    const id = cryptoRandom();
    this.conns.set(id, ws);
    const now = Date.now();
    if (!this.meta.key || now >= this.meta.expiresAt) {
      ws.send(JSON.stringify({ type: "error", error: "session_not_found_or_expired" }));
      ws.close(); return;
    }
    ws.send(JSON.stringify({ type: "joined", key: this.meta.key, lastText: this.meta.lastText, singleUse: this.meta.singleUse, expiresAt: this.meta.expiresAt }));
    ws.addEventListener("message", async (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === "send-text") {
          const text = String(msg.text || "");
          if (text.length > 10000) { ws.send(JSON.stringify({ type: "error", error: "text_too_large" })); return; }
          this.meta.lastText = text;
          await this.state.storage.put("meta", this.meta, { expiration: Math.floor(this.meta.expiresAt/1000) });
          this.broadcast({ type: "new-text", text, ts: Date.now() });
          return;
        }
        if (msg.type === "send-text-e2e") {
          const payload = msg.payload || {};
          this.meta.lastText = "(e2e)";
          await this.state.storage.put("meta", this.meta, { expiration: Math.floor(this.meta.expiresAt/1000) });
          this.broadcast({ type: "new-text-e2e", payload, ts: Date.now() });
          return;
        }
        if (msg.type === "send-file") {
          const file = msg.file || {};
          const size = Number(file.size || 0);
          if (!file.name || !file.dataBase64) { ws.send(JSON.stringify({ type: "error", error: "invalid_file" })); return; }
          if (size > 100*1024) { ws.send(JSON.stringify({ type: "error", error: "file_too_large" })); return; }
          this.broadcast({ type: "new-file", file, ts: Date.now() });
          return;
        }
        if (msg.type === "read") {
          if (this.meta.singleUse) {
            this.broadcast({ type: "session-destroyed", reason: "single_use_read" });
            await this.state.storage.delete("meta"); this.closeAll();
          } else {
            this.broadcast({ type: "read-ack", by: id, at: Date.now() });
          }
          return;
        }
      } catch {}
    });
    ws.addEventListener("close", () => { this.conns.delete(id); });
  }
  broadcast(obj) { const data = JSON.stringify(obj); for (const [, sock] of this.conns) { try { sock.send(data); } catch {} } }
  closeAll() { for (const [, sock] of this.conns) { try { sock.close(); } catch {} } this.conns.clear(); this.meta = { key: null, lastText: "", singleUse: false, expiresAt: 0 }; }
}
function makeKey(len=6){ const abc="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s=""; for(let i=0;i<len;i++) s+=abc[Math.floor(Math.random()*abc.length)]; return s; }
function cryptoRandom(){ const b=new Uint8Array(8); crypto.getRandomValues(b); return Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join(""); }
function json(obj,status=200){ return new Response(JSON.stringify(obj),{status,headers:{ "content-type":"application/json; charset=utf-8"}}); }
