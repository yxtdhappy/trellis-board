/**
 * 极简 HTML → Markdown 转换器（零依赖）。
 *
 * 只覆盖平台任务描述里出现的标签：标题、段落、加粗/斜体、链接、图片、
 * 有序/无序列表、表格、代码块、换行与实体。未知标签按内联文本处理。
 * 转换后用 validateMarkdown 做结构校验，失败时退回纯文本。
 */

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "footer", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "pre", "table", "hr"
]);

const DROPPED_TAGS = new Set(["script", "style", "colgroup", "col", "template", "svg"]);

const HEADING_TAGS = new Map([
  ["h1", 1], ["h2", 2], ["h3", 3], ["h4", 4], ["h5", 5], ["h6", 6]
]);

const ENTITIES = new Map([
  ["nbsp", " "], ["lt", "<"], ["gt", ">"], ["amp", "&"], ["quot", "\""],
  ["apos", "'"], ["#39", "'"], ["#x27", "'"], ["mdash", "—"], ["ndash", "–"],
  ["hellip", "…"], ["middot", "·"], ["ldquo", "“"], ["rdquo", "”"],
  ["lsquo", "‘"], ["rsquo", "’"], ["times", "×"], ["copy", "©"]
]);

export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    const key = body.toLowerCase();
    if (ENTITIES.has(key)) return ENTITIES.get(key);
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function attrValue(tag, name) {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  if (!match) return "";
  return decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
}

function stripDropped(html) {
  let result = String(html);
  for (const tag of DROPPED_TAGS) {
    result = result.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), "");
  }
  result = result.replace(/<!--[\s\S]*?-->/g, "");
  return result;
}

function collapse(text) {
  return String(text).replace(/[ \t\r\f\v]+/g, " ").replace(/\n\s*\n+/g, "\n");
}

function escapeCell(value) {
  return collapse(value)
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
    .trim();
}

function renderTable(rows) {
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.cells.length));
  if (!width) return "";
  const normalized = rows.map((row) => ({
    header: row.header,
    cells: [...row.cells, ...Array(width - row.cells.length).fill("")].map(escapeCell)
  }));
  let headerIndex = normalized.findIndex((row) => row.header);
  if (headerIndex < 0) headerIndex = 0;
  const header = normalized[headerIndex].cells;
  const body = normalized.filter((_, index) => index !== headerIndex);
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.cells.join(" | ")} |`)
  ];
  return lines.join("\n");
}

export function htmlToMarkdown(html, { maxLength = 200_000 } = {}) {
  if (html == null) return "";
  let source = String(html);
  if (source.length > maxLength) source = `${source.slice(0, maxLength)}\n<!-- truncated -->`;
  source = stripDropped(source);

  const blocks = [];
  let inline = "";
  let headingLevel = 0;
  let listStack = [];
  let listItem = null;
  let listLines = null;
  let inTable = false;
  let table = null;
  let row = null;
  let cell = null;
  let cellIsHeader = false;
  let inPre = false;
  let preText = "";
  let linkStack = [];
  let quoteDepth = 0;

  function pushText(value) {
    if (!value) return;
    if (inTable && cell !== null) cell += value;
    else inline += value;
  }

  function flush(prefix = "") {
    const text = inline.replace(/\n{3,}/g, "\n\n").trim();
    inline = "";
    if (!text) return;
    const quoted = quoteDepth > 0
      ? text.split("\n").map((line) => `> ${line}`).join("\n")
      : text;
    blocks.push(`${prefix}${quoted}`);
  }

  function listIndent() {
    return "  ".repeat(Math.max(0, listStack.length - 1));
  }

  function flushListItem() {
    if (!listItem) return;
    const text = listItem.text.trim();
    if (text) {
      const indent = listItem.indent;
      const marker = listItem.ordered ? `${listItem.index}.` : "-";
      const line = `${indent}${marker} ${text.replace(/\n/g, `\n${indent}  `)}`;
      if (listLines) listLines.push(line);
      else blocks.push(line);
    }
    listItem = null;
  }

  const tokens = source.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      if (inPre) {
        preText += decodeEntities(token);
      } else {
        const text = decodeEntities(token).replace(/\s+/g, (match) =>
          match.includes("\n") ? " " : match
        );
        if (listItem) listItem.text += text;
        else pushText(text);
      }
      continue;
    }

    const closing = /^<\//.test(token);
    const tagMatch = /^<\/?\s*([a-zA-Z0-9]+)/.exec(token);
    if (!tagMatch) continue;
    const tag = tagMatch[1].toLowerCase();

    if (inPre) {
      if (tag === "pre" && closing) {
        const code = preText.replace(/\n+$/g, "");
        blocks.push(`\`\`\`text\n${code}\n\`\`\``);
        preText = "";
        inPre = false;
      } else if (tag === "br") {
        preText += "\n";
      }
      continue;
    }

    if (tag === "pre" && !closing) {
      flush();
      inPre = true;
      preText = "";
      continue;
    }

    if (tag === "br") {
      if (inTable && cell !== null) cell += " ";
      else if (listItem) listItem.text += "\n";
      else inline += "\n";
      continue;
    }

    if (tag === "hr") {
      flush();
      blocks.push("---");
      continue;
    }

    if (HEADING_TAGS.has(tag)) {
      if (closing) {
        flush(`${"#".repeat(headingLevel)} `);
        headingLevel = 0;
      } else {
        flush();
        headingLevel = HEADING_TAGS.get(tag);
      }
      continue;
    }

    if (tag === "blockquote") {
      flush();
      quoteDepth = closing ? 0 : quoteDepth + 1;
      continue;
    }

    if (tag === "strong" || tag === "b") {
      if (listItem) listItem.text += "**";
      else pushText("**");
      continue;
    }
    if (tag === "em" || tag === "i") {
      if (listItem) listItem.text += "*";
      else pushText("*");
      continue;
    }
    if (tag === "code" && !inPre) {
      const fence = "`";
      if (listItem) listItem.text += fence;
      else pushText(fence);
      continue;
    }
    if (tag === "a") {
      if (closing) {
        const href = linkStack.pop() || "";
        const suffix = href ? `](${href})` : "]";
        if (listItem) listItem.text += suffix;
        else pushText(suffix);
      } else {
        const href = attrValue(token, "href");
        linkStack.push(href);
        if (listItem) listItem.text += "[";
        else pushText("[");
      }
      continue;
    }
    if (tag === "img") {
      const alt = attrValue(token, "alt") || "图片";
      const src = attrValue(token, "src");
      const markup = src ? `![${alt}](${src})` : `![${alt}]`;
      if (listItem) listItem.text += markup;
      else pushText(markup);
      continue;
    }

    if (tag === "ul" || tag === "ol") {
      if (closing) {
        flushListItem();
        listStack.pop();
        if (!listStack.length && listLines) {
          blocks.push(listLines.join("\n"));
          listLines = null;
        }
      } else {
        flushListItem();
        flush();
        if (!listStack.length) listLines = [];
        listStack.push({ ordered: tag === "ol", index: 0 });
      }
      continue;
    }

    if (tag === "li") {
      flushListItem();
      if (closing) continue;
      const parent = listStack.at(-1);
      if (parent) parent.index += 1;
      listItem = {
        ordered: Boolean(parent?.ordered),
        index: parent?.index ?? 1,
        indent: listIndent(),
        text: ""
      };
      continue;
    }

    if (tag === "table") {
      if (closing) {
        flushTableCell();
        if (table) {
          const rendered = renderTable(table.rows);
          if (rendered) blocks.push(rendered);
        }
        table = null;
        row = null;
        inTable = false;
      } else {
        flush();
        inTable = true;
        table = { rows: [] };
        row = null;
        cell = null;
      }
      continue;
    }

    if (inTable) {
      if (tag === "tr") {
        if (closing) {
          flushTableCell();
          if (row) table.rows.push(row);
          row = null;
        } else {
          row = { cells: [], header: false };
        }
        continue;
      }
      if (tag === "th" || tag === "td") {
        if (closing) {
          flushTableCell();
        } else {
          flushTableCell();
          cell = "";
          cellIsHeader = tag === "th";
          continue;
        }
      }
      if (tag === "caption" && closing) continue;
      continue;
    }

    if (tag === "p" || tag === "div") {
      if (closing) {
        if (listItem) listItem.text += "\n";
        else if (inline.trim()) flush();
      } else if (listItem) {
        listItem.text += "\n";
      } else if (inline.trim()) {
        flush();
      }
      continue;
    }

    if (BLOCK_TAGS.has(tag) && closing) {
      flush();
    }
  }

  function flushTableCell() {
    if (cell === null) return;
    if (row) {
      row.cells.push(cell.trim());
      if (cellIsHeader) row.header = true;
    }
    cell = null;
  }

  if (inPre && preText.trim()) blocks.push(`\`\`\`text\n${preText.replace(/\n+$/g, "")}\n\`\`\``);
  flushListItem();
  flush();

  const output = blocks
    .filter((block) => block !== null && block !== undefined)
    .map((block) => String(block).replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return output;
}

export function validateMarkdown(markdown) {
  const errors = [];
  const lines = String(markdown).split("\n");
  let fenceOpen = false;
  let tableColumns = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith("```")) {
      fenceOpen = !fenceOpen;
      tableColumns = null;
      continue;
    }
    if (fenceOpen) continue;
    if (line.trim().startsWith("|")) {
      const columns = line.replace(/\\\|/g, "").split("|").length - 2;
      if (tableColumns === null) {
        tableColumns = columns;
      } else if (columns !== tableColumns) {
        errors.push(`第 ${index + 1} 行表格列数为 ${columns}，应为 ${tableColumns}`);
      }
    } else {
      tableColumns = null;
    }
    if (line.includes("[object Object]")) {
      errors.push(`第 ${index + 1} 行出现 [object Object]`);
    }
  }
  if (fenceOpen) errors.push("代码围栏未闭合");
  return { ok: errors.length === 0, errors };
}

export function plainTextFromHtml(html) {
  return decodeEntities(
    stripDropped(String(html ?? ""))
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export function safeHtmlToMarkdown(html, options = {}) {
  const markdown = htmlToMarkdown(html, options);
  const validation = validateMarkdown(markdown);
  if (validation.ok) return { markdown, validation };
  return {
    markdown: plainTextFromHtml(html).slice(0, options.maxLength ?? 200_000),
    validation
  };
}
