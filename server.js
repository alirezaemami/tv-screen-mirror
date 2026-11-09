// Screen-mirroring PoC — zero dependencies. Two modes:
//
//  1. WebRTC (low delay):      sender  /        -> TV  /tv
//  2. Buffered stream (smooth): sender /stream  -> TV  /tvstream
//     The Mac records the tab (H.264/AAC) with MediaRecorder and POSTs small
//     chunks here; the TV long-polls them and plays via Media Source Extensions,
//     i.e. the TV's native hardware player, which handles A/V sync itself.
//
// Signaling/control messages travel over Server-Sent Events + POST.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const clients = { sender: new Set(), tv: new Set(), 'stream-sender': new Set(), 'stream-tv': new Set() };
const QUIET = new Set(['tvstats']); // high-frequency messages not worth logging

function send(role, msg) {
  for (const res of clients[role]) res.write(`data: ${JSON.stringify(msg)}\n\n`);
}

function servePage(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(__dirname, 'public', file)).pipe(res);
}

function readBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
  });
}

// ---- Buffered stream state -------------------------------------------------
// Chunk 0 holds the container header (init segment) and is always kept, so a
// TV can start from the beginning of the session. Older chunks are trimmed.
const MAX_CHUNKS = 240; // ~60 s at 250 ms per chunk
const media = { session: 0, mime: '', chunks: new Map(), next: 0, waiters: new Set() };

function firstKept() {
  return Math.max(1, media.next - MAX_CHUNKS);
}

function replyChunk(res, seq) {
  const buf = media.chunks.get(seq);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(buf);
}

function wakeWaiters() {
  for (const w of media.waiters) {
    if (w.session !== media.session) {
      w.res.writeHead(410).end();
    } else if (media.chunks.has(w.seq)) {
      replyChunk(w.res, w.seq);
    } else continue;
    clearTimeout(w.timer);
    media.waiters.delete(w);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'GET' && p === '/') return servePage(res, 'sender.html');
  if (req.method === 'GET' && p === '/tv') return servePage(res, 'tv.html');
  if (req.method === 'GET' && p === '/stream') return servePage(res, 'stream-sender.html');
  if (req.method === 'GET' && p === '/tvstream') return servePage(res, 'stream-tv.html');

  // Each page subscribes to messages addressed to its role.
  if (req.method === 'GET' && p === '/events') {
    const role = url.searchParams.get('role');
    if (!clients[role]) return res.writeHead(400).end();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients[role].add(res);
    console.log(`[${role}] connected (${clients[role].size})`);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients[role].delete(res);
      console.log(`[${role}] disconnected`);
    });
    return;
  }

  // POST /signal?to=<role>  with a JSON body -> forwarded to that role.
  if (req.method === 'POST' && p === '/signal') {
    const to = url.searchParams.get('to');
    if (!clients[to]) return res.writeHead(400).end();
    try {
      const msg = JSON.parse((await readBody(req)).toString());
      if (!QUIET.has(msg.type)) console.log(`-> ${to}: ${msg.type}`);
      send(to, msg);
      res.writeHead(204).end();
    } catch {
      res.writeHead(400).end();
    }
    return;
  }

  // ---- Buffered stream endpoints ----

  // Sender starts a new recording session.
  if (req.method === 'POST' && p === '/media/start') {
    media.session += 1;
    media.mime = url.searchParams.get('mime') || '';
    media.chunks.clear();
    media.next = 0;
    wakeWaiters(); // old-session waiters get 410
    console.log(`[stream] session ${media.session} started: ${media.mime}`);
    send('stream-tv', { type: 'stream-start', session: media.session, mime: media.mime });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ session: media.session }));
  }

  // Sender uploads the next chunk (uploads are serialized on the sender side).
  if (req.method === 'POST' && p === '/media/chunk') {
    const session = Number(url.searchParams.get('session'));
    const body = await readBody(req);
    if (session !== media.session) return res.writeHead(410).end();
    media.chunks.set(media.next, body);
    media.next += 1;
    for (let s = 1; s < firstKept(); s++) media.chunks.delete(s);
    wakeWaiters();
    return res.writeHead(204).end();
  }

  // TV fetches chunk #seq; long-polls up to 10 s if it doesn't exist yet.
  if (req.method === 'GET' && p === '/media/chunk') {
    const session = Number(url.searchParams.get('session'));
    const seq = Number(url.searchParams.get('seq'));
    if (session !== media.session) return res.writeHead(410).end();
    if (seq !== 0 && seq < firstKept()) return res.writeHead(410).end(); // fell too far behind
    if (media.chunks.has(seq)) return replyChunk(res, seq);
    const w = { session, seq, res };
    w.timer = setTimeout(() => { media.waiters.delete(w); res.writeHead(204).end(); }, 10000);
    media.waiters.add(w);
    req.on('close', () => { clearTimeout(w.timer); media.waiters.delete(w); });
    return;
  }

  res.writeHead(404).end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  // Only list real LAN interfaces (en*/eth*/wlan*), skipping VPN tunnels (utun*) etc.
  const ips = Object.entries(os.networkInterfaces())
    .filter(([name]) => /^(en|eth|wlan)/.test(name))
    .flatMap(([, addrs]) => addrs)
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('\nBuffered stream (smooth, recommended):');
  console.log(`  Mac: http://localhost:${PORT}/stream`);
  for (const ip of ips) console.log(`  TV:  http://${ip}:${PORT}/tvstream`);
  console.log('\nWebRTC (low delay):');
  console.log(`  Mac: http://localhost:${PORT}/`);
  for (const ip of ips) console.log(`  TV:  http://${ip}:${PORT}/tv`);
  console.log('');
});
