import { requestJson } from './request'

export async function fetchServerVersion(): Promise<string> {
  const { data } = await requestJson<{ version?: unknown }>('/api/health')
  return typeof data.version === 'string' ? data.version : ''
}
