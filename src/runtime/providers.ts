export type ProviderName = 'qwen' | 'minimax';

const MINIMAX_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3';
const MINIMAX_MODEL = 'minimax-m3';
const MINIMAX_ENV_PREFIX = 'BUA_CUA_MINIMAX';

export function applyProviderEnvironment(provider?: ProviderName): void {
  if (!provider) {
    return;
  }
  process.env.BUA_CUA_ACTIVE_PROVIDER = provider;
  if (provider === 'qwen') {
    return;
  }
  if (provider !== 'minimax') {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  const baseUrl = process.env[`${MINIMAX_ENV_PREFIX}_BASE_URL`] ?? MINIMAX_BASE_URL;
  const apiKey = process.env[`${MINIMAX_ENV_PREFIX}_API_KEY`] ?? '';
  const model = process.env[`${MINIMAX_ENV_PREFIX}_MODEL`] ?? MINIMAX_MODEL;

  process.env.BUA_CUA_GENERATION_BASE_URL = baseUrl;
  process.env.BUA_CUA_GENERATION_MODEL = model;
  process.env.BUA_CUA_RECOVERY_BASE_URL = baseUrl;
  process.env.BUA_CUA_RECOVERY_MODEL = model;
  process.env.MIDSCENE_MODEL_BASE_URL = baseUrl;
  process.env.MIDSCENE_MODEL_NAME = model;
  process.env.OPENAI_BASE_URL = baseUrl;

  if (apiKey) {
    process.env.BUA_CUA_GENERATION_API_KEY = apiKey;
    process.env.BUA_CUA_RECOVERY_API_KEY = apiKey;
    process.env.MIDSCENE_MODEL_API_KEY = apiKey;
    process.env.OPENAI_API_KEY = apiKey;
  }
}
