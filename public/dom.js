export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

export function setMessage(element, message, isError = false) {
  if (!element) return;
  element.hidden = !message;
  element.textContent = message || "";
  element.classList.toggle("is-error", Boolean(isError));
}
