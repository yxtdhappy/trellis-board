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
  /** desktop：桌面客户端内置的本机插件宿主；缺省为服务端插件。 */
  host?: 'team' | 'desktop'
  eventsSrc?: string
}

export async function fetchPanels(): Promise<PluginPanel[]> {
  const { data } = await requestJson<{ panels?: PluginPanel[] }>('/api/panels')
  return data?.panels ?? []
}
