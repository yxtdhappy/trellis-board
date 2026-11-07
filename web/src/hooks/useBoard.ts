import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  acceptTask,
  addRepositories,
  assignTaskRequest,
  createTaskRequest,
  fetchAssignments,
  fetchBoard,
  fetchBoardStatus,
  fetchRepositories,
  fetchTeamStatus,
  pickFolders,
  queryTeamTasks,
  removeRepository,
  saveWipLimit,
  saveSavedView,
  deleteSavedView,
  setTaskStage,
  undoTaskOperation,
  createDependency,
  removeDependency,
  fetchGitOperation,
  retryGitOperation,
} from "@/api/board";
import type {
  BoardPayload,
  BoardStatus,
  Project,
  TeamQueryPage,
  TeamRuntime,
} from "@/api/board";
import { teamRowToBoardTask, type BoardTask } from "@/features/board/task-view";

export type BoardFilters = {
  projectId: string;
  scope: "all" | "mine";
  search: string;
  assignee: string;
  priority: string;
  stage: string;
  blocked: "any" | "blocked" | "unblocked";
  executionView: string;
  archiveProject: string;
  archiveSearch: string;
};
import {
  buildTaskQuery,
  normalizeOperation,
  isRetryableOperation,
  isCompleteOperation,
  operationPollDelay,
} from "@/lib/team-client.js";

const BUILTIN_VIEW_IDS = [
  "all",
  "p0p1",
  "due",
  "stale",
  "implementing",
  "blocked",
] as const;

export function useBoard(): BoardController {
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [status, setStatus] = useState<BoardStatus | null>(null);
  const [runtime, setRuntime] = useState<TeamRuntime | null>(null);
  const [teamPage, setTeamPage] = useState<TeamQueryPage | null>(null);
  const [teamStatus, setTeamStatus] = useState<Record<string, unknown> | null>(
    null,
  );
  const [assignments, setAssignments] = useState<unknown[]>([]);
  const [operation, setOperation] = useState<PublishOperation | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filters, setFiltersState] = useState<BoardFilters>({
    projectId: "all",
    scope: "all",
    search: "",
    assignee: "",
    priority: "",
    stage: "",
    blocked: "any",
    executionView: "all",
    archiveProject: "all",
    archiveSearch: "",
  });

  const operationAttempt = useRef(0);
  const boardEtag = useRef<string | null>(null);
  const teamCursors = useRef<(string | null)[]>([null]);
  const teamPageIndex = useRef(0);
  const loadBoardRef = useRef<
    (force?: boolean, quiet?: boolean) => Promise<void>
  >(async () => {});
  const lastLoadedAtRef = useRef<string | null>(null);

  const teamMode = runtime?.team === true || runtime?.mode === "team";

  const loadBoard = useCallback(async (force = false, quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const payload = await fetchBoard(force);
      if (payload) {
        setBoard(payload);
        lastLoadedAtRef.current = payload.generatedAt ?? null;
        setError("");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  const loadTeamPage = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const cursor = teamCursors.current[teamPageIndex.current] || null;
        const query = buildTaskQuery(
          { ...filters, q: filters.search },
          { limit: 100, cursor },
        );
        const result = await queryTeamTasks(String(query), boardEtag.current);
        if (result.notModified || !result.page) return;
        boardEtag.current = result.etag;
        setTeamPage(result.page);
        if (result.page.nextCursor) {
          teamCursors.current[teamPageIndex.current + 1] =
            result.page.nextCursor;
        }
        setError("");
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [filters],
  );

  const loadTeamStatus = useCallback(async () => {
    try {
      setTeamStatus(await fetchTeamStatus());
    } catch {
      /* 状态轮询失败不打断主流程 */
    }
  }, []);

  const loadAssignments = useCallback(async () => {
    try {
      const payload = await fetchAssignments();
      setAssignments(payload?.assignments || []);
    } catch {
      /* 待接受队列加载失败由页面提示 */
    }
  }, []);

  useEffect(() => {
    let active = true;
    api<TeamRuntime>("/api/runtime")
      .then((data) => {
        if (active && data) setRuntime(data);
      })
      .catch(() => {
        // 独立模式没有 /api/runtime，回落为单人看板
        if (active)
          setRuntime({ team: false, authenticated: true, user: null });
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    loadBoardRef.current = loadBoard;
  }, [loadBoard]);

  useEffect(() => {
    if (!runtime) return;
    if (teamMode) {
      void loadTeamPage(true);
      void loadTeamStatus();
      void loadAssignments();
      const timer = window.setInterval(() => {
        void loadTeamStatus();
      }, 3000);
      return () => window.clearInterval(timer);
    }
    void loadBoard();
    let cancelled = false;
    let timer = 0;
    const poll = async () => {
      if (cancelled) return;
      try {
        const next = await fetchBoardStatus();
        setStatus(next);
        if (
          next?.lastRefreshAt &&
          next.lastRefreshAt !== lastLoadedAtRef.current
        ) {
          lastLoadedAtRef.current = next.lastRefreshAt;
          await loadBoardRef.current(false, true);
        }
      } catch {
        /* 忽略轮询错误，等待下一轮 */
      }
      if (!cancelled) timer = window.setTimeout(poll, 750);
    };
    timer = window.setTimeout(poll, 750);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按运行模式起停轮询
  }, [runtime, teamMode]);

  useEffect(() => {
    if (teamMode) void loadTeamPage(true);
  }, [filters, teamMode, loadTeamPage]);

  const reloadCurrentSource = useCallback(async () => {
    if (teamMode) {
      await loadTeamPage(true);
      return;
    }
    await loadBoard(false, true);
  }, [teamMode, loadBoard, loadTeamPage]);

  const trackOperation = useCallback((payload: unknown) => {
    const next = normalizeOperation(payload) as PublishOperation;
    if (!next?.id && !next?.status) return false;
    operationAttempt.current = 0;
    setOperation(next);
    return true;
  }, []);

  useEffect(() => {
    if (!operation?.id || !isRetryableOperation(operation)) return;
    let cancelled = false;
    const attempt = operationAttempt.current;
    operationAttempt.current += 1;
    const timer = window.setTimeout(async () => {
      try {
        const next = normalizeOperation(
          await fetchGitOperation(String(operation.id)),
        ) as PublishOperation;
        if (cancelled) return;
        setOperation(next);
        if (isCompleteOperation(next)) {
          await reloadCurrentSource();
          await loadTeamStatus();
        }
      } catch (err) {
        if (!cancelled) {
          setOperation((current) =>
            current ? { ...current, error: (err as Error).message } : current,
          );
        }
      }
    }, operationPollDelay(attempt));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [operation, reloadCurrentSource, loadTeamStatus]);

  const setFilters = useCallback((patch: Partial<BoardFilters>) => {
    setFiltersState((current) => ({ ...current, ...patch }));
    if (patch.projectId !== undefined || patch.search !== undefined) {
      teamPageIndex.current = 0;
      teamCursors.current = [null];
      boardEtag.current = null;
    }
  }, []);

  const actions = useMemo(
    () => ({
      refresh: async () => {
        if (teamMode) {
          await loadTeamPage(false);
          await loadTeamStatus();
          return;
        }
        await loadBoard(true);
      },
      saveWip: async (limit: number) => {
        await saveWipLimit(limit);
        await loadBoard(false, true);
      },
      createTask: async (payload: Record<string, unknown>) => {
        const idempotencyKey =
          typeof payload.idempotencyKey === "string" && payload.idempotencyKey
            ? payload.idempotencyKey
            : typeof crypto !== "undefined" &&
                typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const result = await createTaskRequest({ ...payload, idempotencyKey });
        trackOperation(result);
        await reloadCurrentSource();
      },
      assign: async (payload: Record<string, unknown>) => {
        const result = await assignTaskRequest(payload);
        trackOperation(result);
        await reloadCurrentSource();
      },
      setStage: async (payload: {
        projectId: string;
        taskPath: string;
        stage: string;
      }) => {
        await setTaskStage(payload);
        await reloadCurrentSource();
      },
      undo: async (payload: { projectId: string; taskPath: string }) => {
        await undoTaskOperation(payload);
        await reloadCurrentSource();
      },
      addDependency: async (payload: {
        blocked: { projectId: string; taskPath: string };
        blocker: { projectId: string; taskPath: string };
        reason: string;
      }) => {
        await createDependency(payload);
        await reloadCurrentSource();
      },
      removeDependency: async (id: string) => {
        await removeDependency(id);
        await reloadCurrentSource();
      },
      saveView: async (name: string, viewFilter: Record<string, unknown>) => {
        const saved = await saveSavedView({ name, filter: viewFilter });
        await reloadCurrentSource();
        return saved?.view?.id ?? "";
      },
      deleteView: async (id: string) => {
        await deleteSavedView(id);
        if (filters.executionView === id) {
          setFiltersState((current) => ({ ...current, executionView: "all" }));
        }
        await reloadCurrentSource();
      },
      retryOperation: async () => {
        if (!operation?.id) return;
        setOperation(
          normalizeOperation(
            await retryGitOperation(String(operation.id)),
          ) as PublishOperation,
        );
      },
      dismissOperation: () => setOperation(null),
      accept: async (payload: unknown) => {
        await acceptTask(payload);
        await loadAssignments();
        await loadTeamPage(true);
      },
      reloadAssignments: loadAssignments,
      repositories: {
        list: fetchRepositories,
        pick: pickFolders,
        add: async (paths: string[]) => {
          await addRepositories(paths);
          await loadBoard(false, true);
        },
        remove: async (id: string) => {
          await removeRepository(id);
          await loadBoard(false, true);
        },
      },
    }),
    [
      teamMode,
      loadBoard,
      loadTeamPage,
      loadTeamStatus,
      loadAssignments,
      reloadCurrentSource,
      trackOperation,
      operation,
      filters.executionView,
    ],
  );

  const teamProjects = useMemo<Project[]>(() => {
    const rows =
      (teamStatus?.projects as
        { id?: string; name?: string; path?: string }[] | undefined) || [];
    return rows
      .filter((row): row is { id: string; name?: string; path?: string } =>
        Boolean(row?.id),
      )
      .map((row) => ({
        ...row,
        id: row.id,
        name: row.name || row.id,
        path: row.path || "",
      }));
  }, [teamStatus]);
  const projects: Project[] = teamMode ? teamProjects : board?.projects || [];
  const tasks: BoardTask[] = teamMode
    ? (teamPage?.tasks || []).map((row) =>
        teamRowToBoardTask(row as Record<string, unknown>),
      )
    : board?.tasks || [];

  return {
    board,
    tasks,
    projects,
    status,
    runtime,
    teamMode,
    teamPage,
    teamStatus,
    assignments,
    filters,
    setFilters,
    error,
    loading,
    operation,
    actions,
    builtinViews: BUILTIN_VIEW_IDS,
  };
}

export type PublishOperation = {
  id: string | null;
  status?: string;
  code?: string | null;
  error?: string | null;
  operationType?: string | null;
  taskKey?: string | null;
  projectId?: string | null;
  localSha?: string | null;
  remoteSha?: string | null;
  result?: Record<string, unknown>;
  raw?: unknown;
};

export type BoardActions = {
  refresh: () => Promise<void>;
  saveWip: (limit: number) => Promise<void>;
  createTask: (payload: Record<string, unknown>) => Promise<void>;
  assign: (payload: Record<string, unknown>) => Promise<void>;
  setStage: (payload: {
    projectId: string;
    taskPath: string;
    stage: string;
  }) => Promise<void>;
  undo: (payload: { projectId: string; taskPath: string }) => Promise<void>;
  addDependency: (payload: {
    blocked: { projectId: string; taskPath: string };
    blocker: { projectId: string; taskPath: string };
    reason: string;
  }) => Promise<void>;
  removeDependency: (id: string) => Promise<void>;
  saveView: (name: string, filter: Record<string, unknown>) => Promise<string>;
  deleteView: (id: string) => Promise<void>;
  retryOperation: () => Promise<void>;
  dismissOperation: () => void;
  accept: (payload: unknown) => Promise<void>;
  reloadAssignments: () => Promise<void>;
  repositories: {
    list: () => Promise<{ id?: string; name?: string; path?: string }[]>;
    pick: () => Promise<string[]>;
    add: (paths: string[]) => Promise<void>;
    remove: (id: string) => Promise<void>;
  };
};

export type BoardController = {
  board: BoardPayload | null;
  tasks: BoardTask[];
  projects: BoardPayload["projects"];
  status: BoardStatus | null;
  runtime: TeamRuntime | null;
  teamMode: boolean;
  teamPage: TeamQueryPage | null;
  teamStatus: Record<string, unknown> | null;
  assignments: unknown[];
  filters: BoardFilters;
  setFilters: (patch: Partial<BoardFilters>) => void;
  error: string;
  loading: boolean;
  operation: PublishOperation | null;
  actions: BoardActions;
  builtinViews: readonly string[];
};
