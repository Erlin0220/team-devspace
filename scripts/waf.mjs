const CLOUDFLARE_ID = /^[a-f0-9]{32}$/;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

export const GATEWAY_WAF_PHASE = 'http_request_firewall_custom';
export const GATEWAY_WAF_REF = 'team-devspace-gateway-surface';
export const GATEWAY_WAF_DESCRIPTION = 'Restrict Team DevSpace gateway to owned namespaces';
const LEGACY_STATUS_DESCRIPTION = 'Retire legacy Team DevSpace device status endpoint';

const allowedExact = ['/mcp', '/health', '/robots.txt', '/admin', '/v1/enroll', '/v1/update-policy'];
const allowedPrefixes = ['/admin/', '/mcp-app-assets/', '/v1/enrollment/', '/v1/device/', '/v1/admin/', '/cdn-cgi/'];

export function gatewayWafExpression(hostname) {
  if (!HOSTNAME.test(hostname ?? '')) throw new Error('Gateway WAF hostname is invalid');
  const path = 'http.request.uri.path';
  const allowed = [
    ...allowedExact.map(value => `${path} eq "${value}"`),
    ...allowedPrefixes.map(value => `starts_with(${path}, "${value}")`),
  ].join(' or ');
  return `(http.host eq "${hostname}" and (${path} eq "/v1/device/status" or not (${allowed})))`;
}

function desiredRule(hostname) {
  return {
    action: 'block',
    expression: gatewayWafExpression(hostname),
    description: GATEWAY_WAF_DESCRIPTION,
    enabled: true,
    ref: GATEWAY_WAF_REF,
  };
}

function matches(rule, desired) {
  return rule?.action === desired.action && rule?.expression === desired.expression &&
    rule?.description === desired.description && rule?.enabled === true && rule?.ref === desired.ref;
}

function legacyStatusRule(rule, hostname) {
  return rule?.action === 'block' && rule?.enabled === true &&
    rule?.description === LEGACY_STATUS_DESCRIPTION &&
    rule?.expression === `(http.host eq "${hostname}" and http.request.uri.path eq "/v1/device/status")`;
}

function verifiedOwnedRule(ruleset, desired) {
  if (!CLOUDFLARE_ID.test(ruleset?.id ?? '')) throw new Error('Cloudflare returned an invalid WAF ruleset');
  const owned = (ruleset.rules ?? []).filter(rule => rule.ref === GATEWAY_WAF_REF);
  if (owned.length !== 1 || !CLOUDFLARE_ID.test(owned[0]?.id ?? '') || !matches(owned[0], desired)) {
    throw new Error('Team DevSpace WAF rule verification failed');
  }
  return owned[0];
}

export async function ensureGatewayWaf({ api, zoneId, hostname }) {
  if (!CLOUDFLARE_ID.test(zoneId ?? '')) throw new Error('Gateway WAF Zone ID is invalid');
  const desired = desiredRule(hostname);
  const entrypoint = `/zones/${zoneId}/rulesets/phases/${GATEWAY_WAF_PHASE}/entrypoint`;
  let ruleset = await api(entrypoint, 'GET', undefined, { missingOk: true });
  if (!ruleset) {
    ruleset = await api(`/zones/${zoneId}/rulesets`, 'POST', {
      name: 'zone', description: 'Team DevSpace edge contract rules', kind: 'zone',
      phase: GATEWAY_WAF_PHASE, rules: [desired],
    });
  } else {
    if (!CLOUDFLARE_ID.test(ruleset.id ?? '')) throw new Error('Cloudflare returned an invalid WAF ruleset');
    const owned = (ruleset.rules ?? []).filter(rule => rule.ref === GATEWAY_WAF_REF);
    if (owned.length > 1) throw new Error('Multiple Team DevSpace WAF rules claim the same ownership ref');
    if (!owned.length) {
      ruleset = await api(`/zones/${zoneId}/rulesets/${ruleset.id}/rules`, 'POST', desired);
    } else if (!matches(owned[0], desired)) {
      if (!CLOUDFLARE_ID.test(owned[0].id ?? '')) throw new Error('Cloudflare returned an invalid owned WAF rule');
      ruleset = await api(`/zones/${zoneId}/rulesets/${ruleset.id}/rules/${owned[0].id}`, 'PATCH', desired);
    }
  }
  let rule = verifiedOwnedRule(ruleset, desired);
  // Contract originally shipped as one exact legacy-status rule without a stable
  // ownership ref. Retire only that exact historical shape after the new rule is
  // verified; never delete or adopt unrelated rules in the shared Zone.
  for (const legacy of (ruleset.rules ?? []).filter(item => item.id !== rule.id && legacyStatusRule(item, hostname))) {
    if (!CLOUDFLARE_ID.test(legacy.id ?? '')) throw new Error('Cloudflare returned an invalid legacy WAF rule');
    ruleset = await api(`/zones/${zoneId}/rulesets/${ruleset.id}/rules/${legacy.id}`, 'DELETE');
  }
  rule = verifiedOwnedRule(ruleset, desired);
  return { rulesetId: ruleset.id, ruleId: rule.id, ref: rule.ref, expression: rule.expression };
}

export async function verifyGatewayWaf(gateway, fetcher = fetch) {
  const probe = async path => fetcher(new URL(path, gateway), {
    redirect: 'manual', signal: AbortSignal.timeout(15000),
  });
  for (const path of ['/v1/device/status', '/.team-devspace-waf-probe']) {
    const response = await probe(path);
    await response.body?.cancel();
    if (response.status !== 403 || response.headers.has('X-Request-Id')) {
      throw new Error('Team DevSpace WAF is not terminating blocked paths at the Edge');
    }
  }
  const health = await probe('/health');
  await health.body?.cancel();
  if (health.status !== 200 || !health.headers.has('X-Request-Id')) {
    throw new Error('Team DevSpace WAF blocked the Gateway health namespace');
  }
  const mcp = await probe('/mcp');
  await mcp.body?.cancel();
  if (mcp.status !== 401 || !mcp.headers.has('X-Request-Id')) {
    throw new Error('Team DevSpace WAF blocked or bypassed the MCP namespace');
  }
  return true;
}
