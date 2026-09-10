const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ACCESS_APP_NAME = 'Team DevSpace Admin';
export const ACCESS_POLICY_NAME = 'Team DevSpace Administrators';

export function normalizeAdminEmails(values) {
  const emails = [...new Set((Array.isArray(values) ? values : String(values ?? '').split(','))
    .map(value => String(value).trim().toLowerCase()).filter(Boolean))].sort();
  if (!emails.length || emails.some(email => !EMAIL.test(email))) {
    throw new Error('Configure one or more valid Cloudflare Access administrator emails');
  }
  return emails;
}

function domainFor(hostname) { return `${hostname}/admin*`; }

function applicationMatches(application, hostname) {
  const domain = domainFor(hostname);
  const destinations = application?.destinations ?? [];
  return application?.name === ACCESS_APP_NAME && application?.type === 'self_hosted' &&
    application?.session_duration === '8h' && application?.app_launcher_visible === false &&
    (application.domain === domain || destinations.some(item => item.type === 'public' && item.uri === domain));
}

function policyMatches(policy, emails) {
  const include = policy?.include ?? [];
  const policyEmails = include.map(rule => {
    if (Object.keys(rule ?? {}).length !== 1 || Object.keys(rule?.email ?? {}).length !== 1) return null;
    return typeof rule.email.email === 'string' ? rule.email.email.toLowerCase() : null;
  }).sort();
  return policy?.name === ACCESS_POLICY_NAME && policy?.decision === 'allow' && policy?.precedence === 1 &&
    !(policy?.exclude?.length) && !(policy?.require?.length) && include.length === emails.length &&
    !policyEmails.includes(null) && JSON.stringify(policyEmails) === JSON.stringify(emails);
}

export async function ensureAdminAccess({ api, accountId, hostname, administratorEmails,
  applicationId, onApplicationCreated = async () => {} }) {
  const emails = normalizeAdminEmails(administratorEmails);
  const applicationsPath = `/accounts/${accountId}/access/apps`;
  let application;
  if (applicationId) {
    if (!UUID.test(applicationId)) throw new Error('Recorded Access Application ID is invalid');
    application = await api(`${applicationsPath}/${applicationId}`, 'GET', undefined, { missingOk: true });
    if (!application) throw new Error('Recorded Team DevSpace Access Application is missing; refusing to adopt another application');
    if (!applicationMatches(application, hostname)) throw new Error('Recorded Access Application no longer matches Team DevSpace /admin*');
  } else {
    const domain = domainFor(hostname);
    const existing = await api(`${applicationsPath}?domain=${encodeURIComponent(domain)}&exact=true`);
    if (existing.length) throw new Error('An unrecorded Access Application already owns Team DevSpace /admin*; refusing to adopt it');
    application = await api(applicationsPath, 'POST', {
      name: ACCESS_APP_NAME,
      type: 'self_hosted',
      domain,
      destinations: [{ type: 'public', uri: domain }],
      session_duration: '8h',
      app_launcher_visible: false,
    });
    if (!UUID.test(application?.id ?? '')) throw new Error('Cloudflare returned an invalid Access Application');
    await onApplicationCreated(application.id);
  }
  const policiesPath = `${applicationsPath}/${application.id}/policies`;
  const policies = await api(policiesPath);
  const unknown = policies.filter(policy => policy.name !== ACCESS_POLICY_NAME);
  if (unknown.length) throw new Error('Team DevSpace Access Application contains an unmanaged policy; refusing to broaden access');
  const desired = {
    name: ACCESS_POLICY_NAME,
    decision: 'allow',
    precedence: 1,
    include: emails.map(email => ({ email: { email } })),
  };
  let policy = policies.find(item => item.name === ACCESS_POLICY_NAME);
  if (!policy) policy = await api(policiesPath, 'POST', desired);
  else if (!policyMatches(policy, emails)) policy = await api(`${policiesPath}/${policy.id}`, 'PUT', desired);
  if (!policyMatches(policy, emails)) throw new Error('Cloudflare Access policy verification failed');
  if (typeof application.aud !== 'string' || !application.aud) throw new Error('Cloudflare Access Application has no audience tag');
  return { applicationId: application.id, policyId: policy.id, audience: application.aud,
    domain: domainFor(hostname), administratorEmails: emails };
}

export async function verifyAdminProtection(gateway, fetcher = fetch) {
  const response = await fetcher(new URL('/admin', gateway), { redirect: 'manual', signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  const reachedWorker = response.headers.has('X-Request-Id') || body.includes('access_required');
  if (![302, 303, 401, 403].includes(response.status) || reachedWorker || body.includes('Team DevSpace Admin')) {
    throw new Error('Cloudflare Access is not fail-closed for /admin');
  }
  return true;
}
