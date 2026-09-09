import http from 'node:http';

export class ControlError extends Error {
  constructor(status, code) { super(code); this.name = 'ControlError'; this.status = status; this.code = code; }
}

export async function control(origin, path, token, { method = 'POST', body, timeout = 120000 } = {}) {
  let response;
  try {
    response = await fetch(new URL(path, origin), {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error', signal: AbortSignal.timeout(timeout),
    });
  } catch { throw new ControlError(0, 'gateway_unreachable'); }
  let value;
  try { value = await response.json(); } catch { throw new ControlError(response.status, 'invalid_gateway_response'); }
  if (!response.ok) throw new ControlError(response.status, value.error ?? 'gateway_rejected_request');
  return value;
}

// OAuth stays on loopback even on machines with HTTP_PROXY/NODE_OPTIONS proxy hooks configured.
export function loopbackRequest(port, path, { method = 'GET', headers = {}, body, timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 262144) { res.destroy(); reject(new Error('Local response too large')); return; }
        chunks.push(chunk);
      });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Local service timeout')));
    req.once('error', reject);
    req.end(body);
  });
}
