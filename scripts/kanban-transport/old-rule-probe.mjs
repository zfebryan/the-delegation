// Reproduksi aturan liveness LAMA (paksa-close bila tidak ada pong dalam heartbeatTimeoutMs)
// terhadap bridge nyata, untuk memverifikasi angka "6 reconnect dalam 8 detik".
const URL = process.argv[2] ?? 'ws://127.0.0.1:8000/ws';
const HB_MS = 1000;
const TIMEOUT_MS = 800;
const RUN_MS = 8000;

let reconnects = 0;
let closes = 0;
const log = [];
let timer = null;
let hb = null;

function connect() {
  const ws = new WebSocket(URL);
  let lastPong = Date.now();
  let pingSeen = false;

  ws.onopen = () => {
    log.push('open');
    lastPong = Date.now();
    hb = setInterval(() => {
      if (Date.now() - lastPong > TIMEOUT_MS) {
        log.push('heartbeat timeout -> close');
        closes += 1;
        try { ws.close(); } catch {}
        return;
      }
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }, HB_MS);
  };
  ws.onmessage = (m) => {
    lastPong = Date.now();
    let parsed = null;
    try { parsed = JSON.parse(typeof m.data === 'string' ? m.data : ''); } catch {}
    if (parsed && parsed.type === 'pong') { pingSeen = true; return; }
    if (parsed && parsed.type === 'keepalive') log.push('keepalive in');
    else log.push(`frame:${parsed ? parsed.type : 'unparsed'}`);
  };
  ws.onclose = () => { clearInterval(hb); log.push('close'); reconnects += 1; setTimeout(connect, 300); };
  ws.onerror = () => log.push('error');
}

connect();
setTimeout(() => {
  // hitung berapa kali socket ditutup karena aturan lama
  console.log('log        :', JSON.stringify(log));
  console.log('forced closes (rule lama) :', closes);
  console.log('reconnects (delay 300ms)  :', reconnects);
  process.exit(0);
}, RUN_MS);