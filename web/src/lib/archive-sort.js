function completionDay(task) {
  return String(task.completedAt || task.createdAt || "").slice(0, 10);
}

function archiveMoment(task) {
  const raw = task.archivedAt || task.completedAt || task.createdAt || "";
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function formatArchiveTimestamp(task) {
  if (task.archivedAt) {
    const date = new Date(task.archivedAt);
    if (!Number.isNaN(date.getTime())) {
      return [
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        `${pad(date.getHours())}:${pad(date.getMinutes())}`
      ].join(" ");
    }
  }
  return String(task.completedAt || task.createdAt || "");
}

export function sortArchivedTasks(tasks) {
  return [...tasks].sort((left, right) => {
    const momentCompare = archiveMoment(right) - archiveMoment(left);
    if (momentCompare) return momentCompare;
    const dayCompare = completionDay(right).localeCompare(completionDay(left));
    if (dayCompare) return dayCompare;
    return String(left.title).localeCompare(String(right.title), "zh-CN") ||
      String(left.taskKey).localeCompare(String(right.taskKey), "zh-CN");
  });
}
