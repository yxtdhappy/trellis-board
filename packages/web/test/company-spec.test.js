import assert from 'node:assert/strict'
import test from 'node:test'

import {
  companySpecSelectionLabel,
  companySpecStrategyLabel,
  normalizeCompanySpecPlan,
} from '../src/lib/company-spec.js'

test('companySpecSelectionLabel 正确解析特殊项、模板标签和回退值', () => {
  const templates = [
    { id: 'wit-frontend-mom3', label: '前端 MOM3' },
    { id: 'wit-backend-java', label: '后端 Java' },
  ]

  assert.equal(companySpecSelectionLabel('auto', templates), '自动识别（推荐）')
  assert.equal(companySpecSelectionLabel('none', templates), '不套用')
  assert.equal(companySpecSelectionLabel('wit-frontend-mom3', templates), '前端 MOM3')
  assert.equal(companySpecSelectionLabel('unknown-template', templates), 'unknown-template')
})

test('companySpecStrategyLabel 正确解析更新策略标签', () => {
  assert.equal(companySpecStrategyLabel('keep-local'), '保留本地修改（推荐）')
  assert.equal(companySpecStrategyLabel('overwrite'), '覆盖冲突文件')
  assert.equal(companySpecStrategyLabel('replace'), 'replace')
})

test('normalizeCompanySpecPlan 兼容文件路径数组与数字计数', () => {
  const fromArrays = normalizeCompanySpecPlan({
    ok: true,
    plan: {
      action: 'update',
      template: 'wit-frontend-mom3',
      currentTemplate: 'wit-frontend-mom3',
      version: '2026.11.1',
      files: {
        add: ['frontend/new.md'],
        update: ['frontend/index.md', 'guides/index.md'],
        keep: ['frontend/a.md', 'frontend/b.md', 'frontend/c.md'],
        conflict: ['frontend/quality.md'],
        delete: [],
        keepDeleted: ['frontend/old.md'],
      },
    },
  })

  assert.deepEqual(fromArrays?.files, {
    add: 1,
    update: 2,
    keep: 3,
    conflict: 1,
    delete: 0,
    keepDeleted: 1,
  })

  const fromNumbers = normalizeCompanySpecPlan({
    action: 'apply',
    template: 'wit-backend-java',
    files: {
      add: 4,
      update: 0,
      keep: 1,
      conflict: 2,
      delete: 0,
      keepDeleted: 0,
    },
  })

  assert.deepEqual(fromNumbers?.files, {
    add: 4,
    update: 0,
    keep: 1,
    conflict: 2,
    delete: 0,
    keepDeleted: 0,
  })
})
