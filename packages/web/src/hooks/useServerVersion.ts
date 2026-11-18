import { useEffect, useState } from 'react'
import { fetchServerVersion } from '@/api/health'

export function useServerVersion(): string {
  const [version, setVersion] = useState('')

  useEffect(() => {
    let active = true
    fetchServerVersion()
      .then((value) => {
        if (active) setVersion(value)
      })
      .catch(() => {
        /* 旧服务端没有版本字段时保持空字符串 */
      })
    return () => {
      active = false
    }
  }, [])

  return version
}
