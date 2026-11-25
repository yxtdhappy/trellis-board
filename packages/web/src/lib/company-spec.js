function text(value) {
  return typeof value === 'string' ? value : ''
}

function nullableText(value) {
  const result = text(value)
  return result || null
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function templateOption(value) {
  if (!value || typeof value !== 'object') return null
  const id = text(value.id)
  if (!id) return null
  return { id, label: text(value.label) || id, group: text(value.group) || 'other' }
}

function detectedInfo(value) {
  if (!value || typeof value !== 'object') return null
  return {
    projectType: text(value.projectType),
    template: text(value.template),
    evidence: stringList(value.evidence),
    warning: text(value.warning),
  }
}

function operationRecord(value) {
  if (!value || typeof value !== 'object') return null
  return {
    action: text(value.action),
    template: text(value.template),
    version: nullableText(value.version),
    appliedAt: nullableText(value.appliedAt),
    backupPath: nullableText(value.backupPath),
  }
}

export function normalizeCompanySpecStatus(value) {
  if (!value || typeof value !== 'object') return null
  const raw = value.status ?? (value.ok === true ? null : value)
  if (!raw || typeof raw !== 'object') return null
  if (raw.available !== true) return null
  return {
    available: true,
    name: text(raw.name),
    state: text(raw.state) || 'incomplete',
    template: nullableText(raw.template),
    version: nullableText(raw.version),
    generatedAt: nullableText(raw.generatedAt),
    registrySource: nullableText(raw.registrySource),
    registryTemplate: nullableText(raw.registryTemplate),
    entrypoints: stringList(raw.entrypoints),
    warning: text(raw.warning),
    templates: Array.isArray(raw.templates)
      ? raw.templates.map(templateOption).filter(Boolean)
      : [],
    detected: detectedInfo(raw.detected),
    lastOperation: operationRecord(raw.lastOperation),
  }
}

function planFiles(value) {
  if (!value || typeof value !== 'object') {
    return { add: 0, update: 0, keep: 0, conflict: 0, delete: 0, keepDeleted: 0 }
  }
  return {
    add: number(value.add),
    update: number(value.update),
    keep: number(value.keep),
    conflict: number(value.conflict),
    delete: number(value.delete),
    keepDeleted: number(value.keepDeleted),
  }
}

export function normalizeCompanySpecPlan(value) {
  if (!value || typeof value !== 'object') return null
  const raw = value.plan ?? (value.ok === true ? null : value)
  if (!raw || typeof raw !== 'object') return null
  const action = text(raw.action)
  const template = text(raw.template)
  if (!action || !template) return null
  return {
    action,
    template,
    currentTemplate: nullableText(raw.currentTemplate),
    version: nullableText(raw.version),
    generatedAt: nullableText(raw.generatedAt),
    registrySource: nullableText(raw.registrySource),
    markerInvalid: raw.markerInvalid === true,
    requiresBackup: raw.requiresBackup === true,
    entrypoints: stringList(raw.entrypoints),
    files: planFiles(raw.files),
  }
}

export function normalizeCompanySpecApplyResult(value) {
  if (!value || typeof value !== 'object') return null
  const raw = value.result ?? (value.ok === true ? null : value)
  if (!raw || typeof raw !== 'object') return null
  return {
    applied: raw.applied === true,
    action: text(raw.action),
    template: text(raw.template),
    version: nullableText(raw.version),
    backupPath: nullableText(raw.backupPath),
    written: number(raw.written?.length),
    kept: number(raw.kept?.length),
    deleted: number(raw.deleted?.length),
    warning: text(raw.warning),
  }
}

export function companySpecErrorMessage(error, fallback) {
  const raw = error && typeof error === 'object' ? error : null
  const message = text(raw?.message || raw?.error || '')
  if (message) return message
  if (typeof error === 'string' && error.trim()) {
    try {
      const parsed = JSON.parse(error)
      if (typeof parsed?.message === 'string' && parsed.message.trim()) return parsed.message
    } catch {
      return error
    }
  }
  return fallback
}
