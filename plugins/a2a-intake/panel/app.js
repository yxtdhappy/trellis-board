const bridge = window.TrellisBridge.create()

function byId(id) {
  return document.getElementById(id)
}

async function load() {
  byId('status').textContent = '读取中…'
  try {
    const config = await bridge.get('/config')
    byId('base-url').textContent = config?.publicBaseUrl || location.origin
    byId('token').textContent = config?.token || '—'
    byId('repository').textContent = config?.repositoryId || '（当前唯一工作区）'
    byId('assignee').textContent = config?.defaultAssignee || '（未设置）'
    byId('status').textContent = ''
  } catch (error) {
    byId('status').textContent = `读取失败：${error.message}`
  }
}

bridge.onInit(() => {
  void load()
})

byId('refresh').addEventListener('click', () => void load())

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = byId(button.dataset.copy).textContent
    await navigator.clipboard.writeText(text)
    const label = button.textContent
    button.textContent = '已复制'
    setTimeout(() => {
      button.textContent = label
    }, 1200)
  })
}
