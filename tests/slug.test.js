import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeTaskSlug,
  slugifyTaskTitle,
  TASK_SLUG_PATTERN
} from "../public/slug.js";

test("英文和产品名可以生成稳定的语义标识建议", () => {
  assert.equal(
    slugifyTaskTitle("Fix DBXConnectionPool timeout"),
    "fix-dbx-connection-pool-timeout"
  );
  assert.equal(
    slugifyTaskTitle("优化 SQL-Workbench 导出"),
    "sql-workbench"
  );
});

test("纯中文和纯数字标题不会生成伪语义标识", () => {
  assert.equal(slugifyTaskTitle("补齐看板任务导出能力"), "");
  assert.equal(slugifyTaskTitle("2026"), "");
});

test("自动标识满足格式约束并会安全截断", () => {
  const slug = slugifyTaskTitle(`Fix ${"VeryLongWord".repeat(20)} issue`, 40);
  assert.match(slug, TASK_SLUG_PATTERN);
  assert.equal(slug.length <= 40, true);
  assert.equal(slug.endsWith("-"), false);
});

test("手工标识会去除首尾空白并转成小写", () => {
  assert.equal(normalizeTaskSlug("  Board-Export  "), "board-export");
  assert.equal(normalizeTaskSlug(null), "");
});
