/* global process */
/**
 * Trellis Session Start Plugin
 *
 * Injects compact SessionStart context into the model-visible system prompt
 * through OpenCode V2's `session.context` hook. Stored history, the TUI, and
 * the Web/SQLite transcript are not modified.
 */

import { TrellisContext, debugLog, isTrellisSubagent } from "../lib/trellis-context.js"
import {
  prependEphemeralText,
  transcriptHasAssistantMessage,
} from "../lib/context-visibility.js"
import { buildSessionContext } from "../lib/session-utils.js"

const FIRST_REPLY_NOTICE_RE = /<first-reply-notice>[\s\S]*?<\/first-reply-notice>\s*/g

function stripFirstReplyNotice(context) {
  return context.replace(FIRST_REPLY_NOTICE_RE, "")
}

// OpenCode 2.x: `setup(ctx)` registers hooks on the API domains. The V1
// `experimental.chat.messages.transform` return-object form is not executed.
async function server(api) {
  const directory = api.location.directory
  const ctx = new TrellisContext(directory)
  debugLog("session", "Plugin loaded, directory:", directory)

  await api.session.hook("context", (event) => {
    try {
      const messages = event?.messages
      const platformInput = {
        sessionID: event?.sessionID,
        agent: event?.agent,
      }
      const agent = platformInput.agent || "unknown"
      debugLog("session", "session.context called, agent:", agent)

      if (isTrellisSubagent(platformInput)) {
        debugLog("session", "Skipping trellis subagent turn:", agent)
        return
      }

      if (process.env.TRELLIS_HOOKS === "0" || process.env.TRELLIS_DISABLE_HOOKS === "1") {
        debugLog("session", "Skipping - TRELLIS_HOOKS disabled")
        return
      }

      if (process.env.OPENCODE_NON_INTERACTIVE === "1") {
        debugLog("session", "Skipping - non-interactive mode")
        return
      }

      let context = buildSessionContext(ctx, platformInput)
      if (transcriptHasAssistantMessage(messages)) {
        context = stripFirstReplyNotice(context)
      }
      debugLog("session", "Built context, length:", context.length)
      if (Array.isArray(event.system)) {
        event.system.push({ type: "text", text: context })
      } else {
        prependEphemeralText(messages, context)
      }
    } catch (error) {
      debugLog("session", "Error in session.context:", error.message, error.stack)
    }
  })
}

export default { id: "trellis-session-start", setup: server }
