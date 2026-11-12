import { requestJson } from './request.ts'

export type PluginPanel = {
  id: string
  title: string
  entry: string
  placement: 'view' | 'board-tab'
  order: number
  pluginId: string
  pluginName: string
  src: string
}

export async function fetchPanels(): Promise<PluginPanel[]> {
  const { data } = await requestJson<{ panels?: PluginPanel[] }>('/api/panels')
  return data?.panels ?? []
}
