export function canProbeBranch(branch, remoteUrl) {
  return Boolean(String(branch || '').trim() && String(remoteUrl || '').trim())
}
