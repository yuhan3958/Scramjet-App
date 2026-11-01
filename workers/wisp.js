import { connect } from "cloudflare:sockets";
import { parseFrame, frame, continueFrame } from "./wisp-framing.js";
const allowedDomains = new Set(["novelpia.com", "www.novelpia.com"]);
const allowedPorts = new Set([80,443]);
const closeFrame = (id) => frame(4,id,Uint8Array.of(2));

export function upgradeWisp(request) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Upgrade required",{status:426});
  if (request.headers.get("Origin") !== new URL(request.url).origin) return new Response("Forbidden",{status:403});
  const pair = new WebSocketPair();
  const server=pair[1];server.accept();
  const streams=new Map();
  let ended=false;
  const send=(data)=>{if(!ended && server.readyState===1)server.send(data);};
  const usesV2 = Boolean(request.headers.get("Sec-WebSocket-Protocol"));
  let handshakeComplete = !usesV2;
  send(usesV2 ? frame(5, 0, Uint8Array.of(2, 1)) : continueFrame(0));
  function terminate(id) {
    const state=streams.get(id);
    if(!state)return;
    streams.delete(id);
    try{state.socket.close();}catch{}
    send(closeFrame(id));
  }
  server.addEventListener("message",event=>{
    void (async()=>{
      if (!(event.data instanceof ArrayBuffer)) return;
      let msg;
      try { msg=parseFrame(event.data); }catch{return;}
      const id=msg.streamId;
      if (!handshakeComplete) {
        if (msg.type===5 && id===0 && msg.data.length>=2) {
          handshakeComplete=true;
          send(continueFrame(0));
        } else { try { server.close(1002, "Bad Wisp handshake"); } catch {} }
        return;
      }
      if (id===0) return;
      if (msg.type===1) {
        if (streams.has(id)||streams.size>=4||msg.protocol!==1||!allowedPorts.has(msg.port)||!allowedDomains.has(msg.host.toLowerCase())) {
          send(closeFrame(id));return;
        }
        const state={socket:null,writer:null};
        streams.set(id,state);
        try {
          const socket=connect({hostname:msg.host,port:msg.port});
          state.socket=socket;
          const writer=socket.writable.getWriter();state.writer=writer;
          await socket.opened;
          send(continueFrame(id));
          void (async()=>{
            const reader=socket.readable.getReader();
            try {
              while(streams.get(id)===state) {
                const {value,done}=await reader.read();
                if(done)break;
                for(let p=0;p<value.length;p+=32768)send(frame(2,id,value.subarray(p,p+32768)));
              }
            }catch{}finally{terminate(id);}
          })();
        }catch{terminate(id);}
      } else if(msg.type===2){
        const state=streams.get(id);
        if(!state?.writer)return;
        try{await state.writer.write(msg.data);send(continueFrame(id));}catch{terminate(id);}
      }else if(msg.type===4){terminate(id);}
    })().catch(()=>{});
  });
  const cleanup=()=>{ended=true;for(const state of streams.values())try{state.socket?.close();}catch{}streams.clear();};
  server.addEventListener("close",cleanup);
  server.addEventListener("error",cleanup);
  const protocol = request.headers.get("Sec-WebSocket-Protocol");
  const headers = protocol ? { "Sec-WebSocket-Protocol": protocol.split(",")[0].trim() } : {};
  return new Response(null,{status:101,webSocket:pair[0],headers});
}
