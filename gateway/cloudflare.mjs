export class CloudflareError extends Error {
  constructor(status, code = 'cloudflare_unavailable') {
    super(code);
    this.name = 'CloudflareError';
    this.status = status;
    this.code = code;
  }
}

export class Cloudflare {
  constructor(env) {
    this.token = env.CF_API_TOKEN;
    this.account = env.CF_ACCOUNT_ID;
    this.zone = env.CF_ZONE_ID;
    this.domain = env.DEVICE_DOMAIN;
    if (!this.token || !/^[a-f0-9]{32}$/.test(this.account ?? '') ||
        !/^[a-f0-9]{32}$/.test(this.zone ?? '') ||
        !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(this.domain ?? '')) {
      throw new CloudflareError(503, 'cloudflare_not_configured');
    }
    this.tunnelsPath = `/accounts/${this.account}/cfd_tunnel`;
    this.dnsPath = `/zones/${this.zone}/dns_records`;
  }

  async api(path, { method = 'GET', body, missingOk = false } = {}) {
    let response;
    try {
      response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      console.error(JSON.stringify({ event: 'cloudflare_api_failed', method, status: 0, reason: 'network' }));
      throw new CloudflareError(503);
    }
    if (missingOk && response.status === 404) return null;
    if (response.status >= 300 && response.status < 400) throw new CloudflareError(502, 'cloudflare_redirect_rejected');
    let envelope;
    try { envelope = await response.json(); } catch {
      console.error(JSON.stringify({ event: 'cloudflare_api_failed', method, status: response.status, reason: 'invalid_response' }));
      throw new CloudflareError(response.status);
    }
    if (!response.ok || envelope.success === false) {
      // Only numeric provider codes are safe to log; response messages/body can contain credentials.
      const codes = Array.isArray(envelope.errors) ? envelope.errors.map(item => item?.code).filter(Number.isInteger).slice(0, 3) : [];
      console.error(JSON.stringify({ event: 'cloudflare_api_failed', method, status: response.status, codes }));
      throw new CloudflareError(response.status);
    }
    return envelope.result;
  }

  name(bindingId) { return `team-devspace-${bindingId}`; }
  hostname(bindingId) { return `tds-${bindingId.replaceAll('-', '')}.${this.domain}`; }

  async findTunnel(bindingId) {
    const name = this.name(bindingId);
    const tunnels = await this.api(`${this.tunnelsPath}?name=${encodeURIComponent(name)}&is_deleted=false`);
    return tunnels.find(tunnel => tunnel.name === name && !tunnel.deleted_at) ?? null;
  }

  async ensureTunnel(row) {
    let tunnel = row.tunnel_id
      ? await this.api(`${this.tunnelsPath}/${row.tunnel_id}`, { missingOk: true })
      : await this.findTunnel(row.binding_id);
    if (tunnel?.deleted_at) tunnel = null;
    if (tunnel && tunnel.name !== this.name(row.binding_id)) throw new CloudflareError(409, 'tunnel_ownership_mismatch');
    if (!tunnel) {
      try {
        tunnel = await this.api(this.tunnelsPath, {
          method: 'POST', body: { name: this.name(row.binding_id), config_src: 'cloudflare' },
        });
      } catch (error) {
        // Named tunnels are the idempotency primitive; handle simultaneous repair attempts.
        tunnel = await this.findTunnel(row.binding_id);
        if (!tunnel) throw error;
      }
    }
    return { id: tunnel.id, hostname: this.hostname(row.binding_id) };
  }

  async configure(row) {
    await this.api(`${this.tunnelsPath}/${row.tunnel_id}/configurations`, {
      method: 'PUT',
      body: { config: { ingress: [
        { hostname: row.hostname, service: `http://127.0.0.1:${row.bridge_port}`,
          originRequest: { connectTimeout: 10, httpHostHeader: '127.0.0.1' } },
        { service: 'http_status:404' },
      ] } },
    });
    const content = `${row.tunnel_id}.cfargotunnel.com`;
    const existing = await this.api(`${this.dnsPath}?name=${encodeURIComponent(row.hostname)}&type=CNAME`);
    let record = existing.find(item => item.name === row.hostname);
    if (record && (record.content !== content || !record.proxied)) {
      throw new CloudflareError(409, 'dns_ownership_mismatch');
    }
    if (!record) {
      try {
        record = await this.api(this.dnsPath, {
          method: 'POST', body: { type: 'CNAME', name: row.hostname, content, proxied: true, ttl: 1,
            comment: `Team DevSpace enrollment ${row.binding_id}` },
        });
      } catch (error) {
        const retry = await this.api(`${this.dnsPath}?name=${encodeURIComponent(row.hostname)}&type=CNAME`);
        record = retry.find(item => item.name === row.hostname && item.content === content && item.proxied);
        if (!record) throw error;
      }
    }
    return { dnsId: record.id, tunnelToken: await this.api(`${this.tunnelsPath}/${row.tunnel_id}/token`) };
  }

  async remove(row) {
    if (!row.binding_id) return;
    const tunnel = row.tunnel_id
      ? await this.api(`${this.tunnelsPath}/${row.tunnel_id}`, { missingOk: true })
      : await this.findTunnel(row.binding_id);
    if (tunnel && !tunnel.deleted_at) {
      if (tunnel.name !== this.name(row.binding_id)) throw new CloudflareError(409, 'tunnel_ownership_mismatch');
      // Disable ingress BEFORE disconnecting, then delete the tunnel to invalidate its token.
      await this.api(`${this.tunnelsPath}/${tunnel.id}/configurations`, {
        method: 'PUT', body: { config: { ingress: [{ service: 'http_status:410' }] } },
      });
      // Rotate first: otherwise an old connector can reconnect between cleanup and deletion.
      const retiredSecret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      await this.api(`${this.tunnelsPath}/${tunnel.id}`, {
        method: 'PATCH', body: { tunnel_secret: retiredSecret },
      });
      await this.api(`${this.tunnelsPath}/${tunnel.id}/connections`, { method: 'DELETE', missingOk: true });
      await this.api(`${this.tunnelsPath}/${tunnel.id}`, { method: 'DELETE', missingOk: true });
    }
    const hostname = row.hostname ?? this.hostname(row.binding_id);
    const records = await this.api(`${this.dnsPath}?name=${encodeURIComponent(hostname)}&type=CNAME`);
    for (const record of records) {
      const tunnelId = row.tunnel_id ?? tunnel?.id;
      if (record.name !== hostname || !tunnelId || record.content !== `${tunnelId}.cfargotunnel.com`) continue;
      await this.api(`${this.dnsPath}/${record.id}`, { method: 'DELETE', missingOk: true });
    }
  }
}
