export function createRefreshCoordinator(run) {
  let inFlight = null
  let pending = false
  let disposed = false

  function start() {
    if (disposed) return Promise.resolve()
    const current = (async () => {
      try {
        while (pending && !disposed) {
          pending = false
          await run()
        }
      } finally {
        inFlight = null
        if (pending && !disposed) start()
      }
    })()
    inFlight = current
    return current
  }

  return {
    request() {
      if (disposed) return Promise.resolve()
      pending = true
      return inFlight || start()
    },
    dispose() {
      disposed = true
      pending = false
    },
  }
}
