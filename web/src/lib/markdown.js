const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function safeHref(value) {
  const href = String(value || "").trim();
  if (!href) return null;
  if (href.startsWith("#")) return href;
  try {
    const parsed = new URL(href, "https://trellis-board.invalid");
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? href : null;
  } catch {
    return null;
  }
}

function renderInline(value) {
  const tokens = [];
  const stash = (html) => {
    const index = tokens.push(html) - 1;
    return `\u0000md-token-${index}\u0000`;
  };
  let text = String(value ?? "");

  text = text.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (match, label, href, title) => {
    const safeLink = safeHref(href);
    if (!safeLink) return match;
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    return stash(
      `<a href="${escapeHtml(safeLink)}"${titleAttribute} target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    );
  });

  text = escapeHtml(text);
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

  return text.replace(/\u0000md-token-(\d+)\u0000/g, (_, index) => tokens[Number(index)] || "");
}

function countIndent(line) {
  return line.match(/^\s*/)?.[0].length || 0;
}

function parseListLine(line) {
  const match = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    ordered: /\d/.test(match[2]),
    number: /\d/.test(match[2]) ? Number.parseInt(match[2], 10) : 1,
    content: match[3]
  };
}

function isFenceStart(line) {
  return /^\s{0,3}(`{3,}|~{3,})(.*)$/.test(line);
}

function isHeading(line) {
  return /^\s{0,3}#{1,6}\s+/.test(line);
}

function isHorizontalRule(line) {
  const compact = line.trim();
  return /^([-*_])(?:\s*\1){2,}$/.test(compact);
}

function splitTableRow(line) {
  const source = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let buffer = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\" && source[index + 1] === "|") {
      buffer += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(buffer.trim());
      buffer = "";
    } else {
      buffer += char;
    }
  }
  cells.push(buffer.trim());
  return cells;
}

function parseTableAlignment(line) {
  const cells = splitTableRow(line);
  const alignments = cells.map((cell) => {
    const value = cell.trim();
    if (!/^:?-{3,}:?$/.test(value)) return null;
    if (value.startsWith(":") && value.endsWith(":")) return "center";
    if (value.endsWith(":")) return "right";
    return "left";
  });
  return alignments.every(Boolean) ? alignments : null;
}

function isTableStart(lines, index) {
  return lines[index].includes("|")
    && Boolean(lines[index + 1])
    && parseTableAlignment(lines[index + 1]) !== null;
}

function renderListItem(content) {
  const task = content.match(/^\[([ xX])\]\s+(.*)$/);
  if (!task) return renderInline(content);
  const checked = task[1].toLowerCase() === "x";
  return `<span class="md-checkbox ${checked ? "is-checked" : ""}" aria-label="${checked ? "已完成" : "未完成"}">${checked ? "✓" : ""}</span>${renderInline(task[2])}`;
}

function renderList(lines, start, depth) {
  const first = parseListLine(lines[start]);
  const tag = first.ordered ? "ol" : "ul";
  const items = [];
  let index = start;

  while (index < lines.length) {
    const item = parseListLine(lines[index]);
    if (!item || item.indent !== first.indent || item.ordered !== first.ordered) break;
    const content = item.content;
    index += 1;
    const nestedLines = [];

    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        let next = index + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        if (next >= lines.length) {
          index = next;
          break;
        }
        const nextItem = parseListLine(lines[next]);
        if (nextItem && nextItem.indent === first.indent) {
          index = next;
          break;
        }
        if ((nextItem && nextItem.indent > first.indent) || countIndent(lines[next]) > first.indent) {
          nestedLines.push("");
          index += 1;
          continue;
        }
        index = next;
        break;
      }

      const nextItem = parseListLine(line);
      const indent = countIndent(line);
      if (nextItem && nextItem.indent <= first.indent) break;
      if (!nextItem && indent <= first.indent) break;
      nestedLines.push(line.slice(Math.min(indent, first.indent + 2)));
      index += 1;
    }

    const nested = nestedLines.length ? renderMarkdown(nestedLines.join("\n"), depth + 1) : "";
    items.push(`<li>${renderListItem(content)}${nested}</li>`);
  }

  const startAttribute = first.ordered && first.number !== 1 ? ` start="${first.number}"` : "";
  return {
    html: `<${tag}${startAttribute}>${items.join("")}</${tag}>`,
    index
  };
}

function renderTable(lines, start) {
  const header = splitTableRow(lines[start]);
  const alignments = parseTableAlignment(lines[start + 1]);
  const rows = [];
  let index = start + 2;

  while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
    const cells = splitTableRow(lines[index]);
    while (cells.length < header.length) cells.push("");
    rows.push(cells.slice(0, header.length));
    index += 1;
  }

  const cell = (tag, value, column) => {
    const alignment = alignments[column];
    return `<${tag}${alignment && alignment !== "left" ? ` style="text-align:${alignment}"` : ""}>${renderInline(value)}</${tag}>`;
  };
  const headerHtml = header.map((value, column) => cell("th", value, column)).join("");
  const bodyHtml = rows.map((row) => `<tr>${row.map((value, column) => cell("td", value, column)).join("")}</tr>`).join("");
  return {
    html: `<div class="md-table-wrap"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`,
    index
  };
}

function lineStartsBlock(lines, index) {
  const line = lines[index];
  return isFenceStart(line)
    || isHeading(line)
    || isHorizontalRule(line)
    || /^\s{0,3}>/.test(line)
    || Boolean(parseListLine(line))
    || isTableStart(lines, index);
}

export function renderMarkdown(markdown, depth = 0) {
  if (depth > 6) return `<p>${renderInline(markdown)}</p>`;

  const lines = String(markdown ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\t/g, "  "));
  const output = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[1][0];
      const minimumLength = fence[1].length;
      const language = fence[2].trim().split(/\s+/)[0] || "";
      const code = [];
      index += 1;
      while (index < lines.length) {
        const closing = lines[index].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (closing && closing[1][0] === marker && closing[1].length >= minimumLength) {
          index += 1;
          break;
        }
        code.push(lines[index]);
        index += 1;
      }
      const languageAttribute = language ? ` data-language="${escapeHtml(language)}"` : "";
      output.push(`<pre class="md-code"${languageAttribute}><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (isHorizontalRule(line)) {
      output.push("<hr>");
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      const table = renderTable(lines, index);
      output.push(table.html);
      index = table.index;
      continue;
    }

    if (/^\s{0,3}>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s{0,3}>\s?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${renderMarkdown(quote.join("\n"), depth + 1)}</blockquote>`);
      continue;
    }

    if (parseListLine(line)) {
      const list = renderList(lines, index, depth);
      output.push(list.html);
      index = list.index;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !lineStartsBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    output.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return output.join("\n");
}
