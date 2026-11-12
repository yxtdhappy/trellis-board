import { useMemo } from 'react'
import { Input } from '@/components/ui/input'
import { TRELLIS_AGENT_TOOLS } from '@shared/trellis-agent-tools.js'

type AgentToolSelectorProps = {
  existingTools: readonly string[]
  selectedTools: readonly string[]
  search: string
  disabled?: boolean
  onSearchChange: (value: string) => void
  onToggleTool: (id: string) => void
}

export function AgentToolSelector({
  existingTools,
  selectedTools,
  search,
  disabled = false,
  onSearchChange,
  onToggleTool,
}: AgentToolSelectorProps) {
  const existingToolIds = useMemo(() => new Set(existingTools), [existingTools])
  const selectedToolIds = useMemo(() => new Set(selectedTools), [selectedTools])
  const visibleTools = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return TRELLIS_AGENT_TOOLS
    return TRELLIS_AGENT_TOOLS.filter(
      (tool) => tool.label.toLowerCase().includes(query) || tool.id.toLowerCase().includes(query),
    )
  }, [search])

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="font-medium">本机编码 Agent</p>
          <p className="text-muted-foreground">
            只影响当前电脑；已初始化的工具不会重复写入，其他设备无需选择相同工具。
          </p>
        </div>
        <Input
          type="search"
          aria-label="搜索 Agent"
          className="h-8 w-full sm:w-52"
          placeholder="搜索名称或 ID"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
      <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
        {visibleTools.length ? (
          visibleTools.map((tool) => {
            const existing = existingToolIds.has(tool.id)
            return (
              <label
                key={tool.id}
                className={
                  existing
                    ? 'flex items-center gap-2 rounded-md border border-border px-2.5 py-2 opacity-60'
                    : 'flex items-center gap-2 rounded-md border border-border px-2.5 py-2'
                }
              >
                <input
                  type="checkbox"
                  checked={existing || selectedToolIds.has(tool.id)}
                  disabled={existing || disabled}
                  onChange={() => onToggleTool(tool.id)}
                />
                <span>{tool.label}</span>
                {existing ? (
                  <span className="ml-auto text-[10px] text-muted-foreground">已初始化</span>
                ) : null}
              </label>
            )
          })
        ) : (
          <p className="rounded-md border border-dashed border-border px-2.5 py-3 text-muted-foreground sm:col-span-2">
            没有匹配的 Agent
          </p>
        )}
      </div>
    </div>
  )
}
