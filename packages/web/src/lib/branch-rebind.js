export function normalizeBranchInspection(value) {
  const source = value && typeof value === 'object' ? value : {}
  const repoPath = typeof source.repoPath === 'string' ? source.repoPath : ''
  const currentBranch =
    typeof source.currentBranch === 'string' && source.currentBranch.trim()
      ? source.currentBranch.trim()
      : null
  const seen = new Set()
  const branches = []
  for (const item of Array.isArray(source.branches) ? source.branches : []) {
    const name = typeof item === 'string' ? item.trim() : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    branches.push(name)
  }
  return { repoPath, currentBranch, branches }
}

export function branchRebindView(value, boundBranchValue) {
  const inspection = normalizeBranchInspection(value)
  const boundBranch = typeof boundBranchValue === 'string' ? boundBranchValue.trim() : ''
  const currentBranch = inspection.currentBranch
  const rows = inspection.branches.map((name) => ({
    name,
    current: name === currentBranch,
    bound: name === boundBranch,
    selectable: Boolean(currentBranch) && name === currentBranch,
  }))
  let reason = ''
  if (!currentBranch) {
    reason = '本地仓库处于 detached HEAD，请先检出一个本地分支'
  } else if (inspection.branches.length === 0) {
    reason = '仓库没有可用的本地分支'
  } else if (!inspection.branches.includes(currentBranch)) {
    reason = '当前检出分支不在本地分支列表中，请重新打开弹窗'
  } else if (boundBranch && currentBranch === boundBranch) {
    reason = `当前检出分支 ${currentBranch} 已是绑定分支，请先在本地仓库切换到其他分支`
  }
  const canRebind =
    Boolean(currentBranch) &&
    inspection.branches.includes(currentBranch) &&
    currentBranch !== boundBranch
  return {
    repoPath: inspection.repoPath,
    currentBranch,
    boundBranch,
    rows,
    canRebind,
    targetBranch: canRebind ? currentBranch : null,
    reason: canRebind ? '' : reason,
  }
}

export function branchRebindErrorMessage(error) {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
  const message = text.trim()
  if (
    /command\s+\S+\s+not\s+found/i.test(message) ||
    /not allowed/i.test(message) ||
    /unknown command/i.test(message)
  ) {
    return '当前客户端版本不支持重新绑定分支，请升级客户端'
  }
  return message || '读取本地分支失败，请稍后重试'
}
