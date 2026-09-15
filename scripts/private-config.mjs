import { readJson } from '../client/state.mjs';

export async function deploymentConfig(env = process.env) {
  let config;
  try { config = env.TEAM_DEVSPACE_DEPLOYMENT_JSON ? JSON.parse(env.TEAM_DEVSPACE_DEPLOYMENT_JSON)
    : await readJson('.runtime/deployment.json'); }
  catch { throw new Error('Supply TEAM_DEVSPACE_DEPLOYMENT_JSON or private .runtime/deployment.json'); }
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (!config || Object.keys(config).some(key => !['zoneId', 'databaseId', 'accessApplicationId'].includes(key)) ||
      !/^[a-f0-9]{32}$/.test(config.zoneId ?? '') || !uuid.test(config.databaseId ?? '') ||
      (config.accessApplicationId !== null && !uuid.test(config.accessApplicationId ?? ''))) {
    throw new Error('Invalid private deployment configuration');
  }
  return config;
}
