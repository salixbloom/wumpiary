import * as http from 'http';
import * as crypto from 'crypto';
import type { Socket } from 'net';

// Minimal RFC 6455 WebSocket server (no deps) — enough for localhost text
// frames. Stands in for a Discord-gateway-like connection so we can study
// background throttling/exemption and reconnection behavior. NOT production WS.

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface WsHub {
  port: number;
  broadcast: (msg: string) => void;
  dropAll: () => void; // sever sockets but keep listening (transient drop)
  clients: () => number;
  close: () => Promise<void>; // stop listening entirely (outage)
}

function encodeText(msg: string): Buffer {
  const payload = Buffer.from(msg);
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}

export function startWsServer(port: number): Promise<WsHub> {
  const sockets = new Set<Socket>();
  const server = http.createServer();

  server.on('upgrade', (req, socket: Socket) => {
    const key = req.headers['sec-websocket-key'] as string;
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on('data', (buf) => decodeAndHandle(socket, buf));
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });

  function decodeAndHandle(socket: Socket, buf: Buffer) {
    // Single-pass decode; localhost frames arrive whole. We only care about the
    // close opcode (0x8) — incoming text is just keepalive we can ignore.
    let off = 0;
    while (off + 2 <= buf.length) {
      const b1 = buf[off + 1];
      const opcode = buf[off] & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let p = off + 2;
      if (len === 126) { len = buf.readUInt16BE(p); p += 2; }
      else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8; }
      if (masked) p += 4; // skip mask key; we don't need the payload
      off = p + len;
      if (opcode === 0x8) { try { socket.end(); } catch { /* noop */ } sockets.delete(socket); return; }
    }
  }

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () =>
      resolve({
        port,
        broadcast: (msg) => {
          const frame = encodeText(msg);
          for (const s of sockets) { try { s.write(frame); } catch { /* noop */ } }
        },
        dropAll: () => { for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } } sockets.clear(); },
        clients: () => sockets.size,
        close: () => new Promise((r) => { for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } } sockets.clear(); server.close(() => r()); }),
      }),
    );
  });
}
