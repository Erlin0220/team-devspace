import http from 'node:http';

export class ControlError extends Error {
  constructor(status, code) { super(code); this.name = 'ControlError'; this.status = status; this.code = code; }
}

export async function control(origin, path, token, { method = 'POST', body, timeout = 120000 } = {}) {
  const url = new URL(path, origin);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const payload = body === undefined ? undefined : JSON.stringify(body);
  let status;
  let text;
  try {
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') {
      const local = await loopbackRequest(Number(url.port || 80), `${url.pathname}${url.search}`, {
        method, headers, body: payload, timeout,
      });
      status = local.status;
      text = local.text;
    } else {
      const response = await fetch(url, {
        method, headers, ...(payload === undefined ? {} : { body: payload }),
        redirect: 'error', signal: AbortSignal.timeout(timeout),
      });
      status = response.status;
      text = await response.text();
    }
  } catch { throw new ControlError(0, 'gateway_unreachable'); }
  let value;
  try { value = JSON.parse(text); } catch { throw new ControlError(status, 'invalid_gateway_response'); }
  if (status < 200 || status >= 300) throw new ControlError(status, value.error ?? 'gateway_rejected_request');
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
