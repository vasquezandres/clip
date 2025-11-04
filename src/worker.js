// Solutech Clip — v3.4.2 (Cloudflare Worker + Durable Object)
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/api/create" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { singleUse = false, ttlSeconds = 900, customKey } = body;
      let key = (customKey || "").toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(key)) key = makeKey(6);
      const id = env.ROOMS.idFromName(key);
      const stub = env.ROOMS.get(id);
      const stat = await stub.fetch("https://do/session/status");
      if (stat.status === 200) return json({ ok:false, error:"key_in_use" }, 409);
      const now = Date.now();
      const expiresAt = now + Math.max(60, Math.min(Number(ttlSeconds)||900, 3600)) * 1000;
      await stub.fetch("https://do/session/create", { method:"POST", body: JSON.stringify({ singleUse, expiresAt }) });
      const joinUrl = `${url.origin}/join.html?key=${encodeURIComponent(key)}`;
      return json({ ok:true, key, joinUrl, expiresAt, singleUse });
    }
    if (url.pathname === "/ws") {
      const key = (url.searchParams.get("key") || "").toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(key)) return new Response("Invalid key", { status:400 });
      const id = env.ROOMS.idFromName(key);
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
  constructor(state, env){
    this.state = state; this.env = env;
    this.conns = new Map();
    this.meta = { singleUse:false, expiresAt:0 };
    this.state.blockConcurrencyWhile(async () => {
      const m = await this.state.storage.get("meta"); if (m) this.meta = m;
    });
  }
  async fetch(request){
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const pair = new WebSocketPair();
      await this.handleSocket(pair[1]);
      return new Response(null, { status:101, webSocket: pair[0] });
    }
    if (url.pathname === "/session/create" && request.method === "POST") {
      const { singleUse, expiresAt } = await request.json();
      this.meta.singleUse = !!singleUse; this.meta.expiresAt = Number(expiresAt)||0;
      await this.state.storage.put("meta", this.meta, { expiration: Math.floor(this.meta.expiresAt/1000) });
      return json({ ok:true });
    }
    if (url.pathname === "/session/status") {
      const now = Date.now();
      if (!this.meta.expiresAt || now >= this.meta.expiresAt) return json({ ok:false, error:"not_found_or_expired" }, 404);
      return json({ ok:true, singleUse:this.meta.singleUse, expiresAt:this.meta.expiresAt });
    }
    return new Response("Not found", { status:404 });
  }
  async handleSocket(ws){
    ws.accept();
    const id = cryptoRandom();
    this.conns.set(id, ws);
    const now = Date.now();
    if (!this.meta.expiresAt || now >= this.meta.expiresAt) {
      ws.send(JSON.stringify({ type:"error", error:"session_not_found_or_expired" }));
      ws.close(); return;
    }
    ws.send(JSON.stringify({ type:"joined", singleUse:this.meta.singleUse, expiresAt:this.meta.expiresAt }));
    ws.addEventListener("message", async (evt)=>{
      try{
        const msg = JSON.parse(evt.data);
        if (msg.type === "send-e2e") {
          const { payload, file_limit_kb } = msg;
          const serverLimitKB = Number(this.env.MAX_FILE_KB || 200);
          const clientLimitKB = Number(file_limit_kb || serverLimitKB);
          const limitKB = Math.min(serverLimitKB, clientLimitKB);
          if (payload?.kind === "file") {
            const b64 = payload?.data?.cipher || "";
            const approx = Math.floor(b64.length * 3 / 4);
            if (approx > limitKB * 1024) {
              ws.send(JSON.stringify({ type:"error", error:"file_too_large_server_limit" }));
              return;
            }
          }
          this.broadcast({ type:"new-e2e", payload, ts: Date.now() });
          return;
        }
        if (msg.type === "read") {
          if (this.meta.singleUse) {
            this.broadcast({ type:"session-destroyed", reason:"single_use_read" });
            await this.state.storage.delete("meta");
            this.closeAll();
          } else {
            this.broadcast({ type:"read-ack", by:id, at:Date.now() });
          }
          return;
        }
      }catch{}
    });
    ws.addEventListener("close", ()=> this.conns.delete(id));
  }
  broadcast(obj){
    const s = JSON.stringify(obj);
    for (const [,sock] of this.conns){ try{ sock.send(s); }catch{} }
  }
  closeAll(){ for(const [,sock] of this.conns){ try{ sock.close(); }catch{} } this.conns.clear(); this.meta={singleUse:false,expiresAt:0}; }
}
function makeKey(len=6){ const ABC="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s=""; for(let i=0;i<len;i++) s+=ABC[Math.floor(Math.random()*ABC.length)]; return s; }
function cryptoRandom(){ const b=new Uint8Array(8); crypto.getRandomValues(b); return Array.from(b).map(x=>x.toString(16).padStart(2,"0")).join(""); }
function json(obj,status=200){ return new Response(JSON.stringify(obj),{status,headers:{ "content-type":"application/json; charset=utf-8" }}); }
