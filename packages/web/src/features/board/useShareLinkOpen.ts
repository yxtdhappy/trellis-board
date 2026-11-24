import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { api } from '@/api/board'
import { ApiError } from '@/api/request'
import { invoke, listen } from '@/desktop/tauri'
import { appOriginWithBase } from '@/lib/base-path.js'
import { isSameShareServer, taskIdFromExecutionKey } from '@/lib/share-link.ts'
import type { BoardTask } from './task-view.ts'

type ShareTarget = {
  kind?: 'target'
  server: string
  taskSpaceId: string
  taskId: string
}

type PendingShare = { kind: 'invalid' } | ShareTarget

type ShareLinkOpenOptions = {
  tasks: BoardTask[]
  onOpen: (task: BoardTask) => void
  enabled?: boolean
}

/**
 * 处理桌面端转发的任务分享链接：链接定位参数只用于查找任务，
 * 打开前必须比对当前 Board 服务基址（含子路径），避免同域不同子路径或外部地址串开。
 */
export function useShareLinkOpen({ tasks, onOpen, enabled = true }: ShareLinkOpenOptions) {
  const tasksRef = useRef(tasks)
  const onOpenRef = useRef(onOpen)

  // 事件监听器只在启用且挂载时注册一次，用这个副作用把最新数据同步给它。
  useEffect(() => {
    tasksRef.current = tasks
    onOpenRef.current = onOpen
  })

  useEffect(() => {
    const invokeCommand = invoke
    const listenEvent = listen
    if (!enabled || !invokeCommand || !listenEvent) return
    let active = true
    let stop: (() => void) | undefined
    let reading = false
    let readingAgain = false
    let latest = 0

    const openTarget = async (target: ShareTarget, sequence: number) => {
      if (!active) return
      if (!isSameShareServer(target.server, appOriginWithBase())) {
        toast.error('该分享链接来自其他服务地址，请用分享时的地址登录后再打开')
        return
      }
      const existing = tasksRef.current.find(
        (task) =>
          task.taskSpaceId === target.taskSpaceId &&
          taskIdFromExecutionKey(task.executionTaskKey) === target.taskId,
      )
      if (existing) {
        onOpenRef.current(existing)
        return
      }
      try {
        const executionTaskKey = `${target.taskSpaceId}::${target.taskId}`
        const query = new URLSearchParams({
          taskSpaceId: target.taskSpaceId,
          executionTaskKey,
        }).toString()
        const payload = await api<{ task?: BoardTask }>(`/api/tasks?${query}`)
        if (!active || sequence !== latest) return
        if (!payload?.task) throw new Error('任务不存在')
        // 后到的链接优先：更早发出的请求晚返回时不再抢焦点。
        onOpenRef.current(payload.task)
      } catch (error) {
        if (!active || sequence !== latest) return
        if (error instanceof ApiError && error.code === 'PASSWORD_CHANGE_REQUIRED') {
          toast.error('请先完成修改密码后再打开该任务')
        } else {
          toast.error('无法打开该任务：链接可能已失效，或当前账号没有访问权限')
        }
      }
    }

    const takePending = async () => {
      if (!active) return
      // 读取期间又来链接：Rust 侧暂存已被覆盖，读完必须再取一次，否则后一条会丢。
      if (reading) {
        readingAgain = true
        return
      }
      reading = true
      try {
        const pending = await invokeCommand<PendingShare | null>('take_pending_share_link')
        if (!active || !pending) return
        latest += 1
        if ('kind' in pending && pending.kind === 'invalid') {
          toast.error('任务分享链接格式无效，请让分享人重新复制')
          return
        }
        void openTarget(pending, latest)
      } catch {
        // 旧客户端没有该命令：只保留分享复制能力。
      } finally {
        reading = false
        if (readingAgain) {
          readingAgain = false
          if (active) void takePending()
        }
      }
    }

    // 先监听再读取暂存值，避免两者之间到来的链接丢失。
    void listenEvent('share-link-open', () => {
      if (active) void takePending()
    })
      .then((unlisten) => {
        if (active) {
          stop = unlisten
          void takePending()
        } else {
          unlisten()
        }
      })
      .catch(() => {
        // 监听失败不影响冷启动时已暂存的那一条。
        if (active) void takePending()
      })

    return () => {
      active = false
      stop?.()
    }
  }, [enabled])
}
