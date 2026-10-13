/** Public surface of the Marg core runtime. */
export { REPO_ROOT, envList, envNotFalse, envNum, envNum0, envTrue } from "./env.js";
export { ATTR, BRAND, DEPLOY_ENV, METRIC_PREFIX, SERVICE_NAMESPACE, WRITES_ALLOWED, metricName } from "./config.js";
export { flushLogs, head, log, logConfig, redact, summarize } from "./logger.js";
export * from "./otel.js";
export { metricsSnapshot, primeMetrics, recordCapped, recordRateLimited, recordRequest, recordTurn } from "./metrics.js";
export { LlmUnavailableError, activeProvider, chatComplete, chatCompleteStream, llmChain, llmChainSnapshot, llmConfig, registerMockModel, resetLlmChain, type CallOpts, type ChatMessage, type LlmEndpoint, type MockModel, type TokenUsage, type ToolCall, type ToolDef } from "./llm.js";
export { trimConfig, trimHistoryToolResults, trimToolResult } from "./context-trim.js";
export { AUTH_META_KEY, SESSION_META_KEY, callDomainTool, closeAllMcp, connectDomainMcp, getDomainToolDefs, isInternalTool, mcpState } from "./mcp-client.js";
export { SECURITY_PREAMBLE, buildDomainPrompt, capabilitiesStatement, clearPromptCache, listCapabilities, readSkillBody, registerCapabilities } from "./prompt.js";
export { detectType, handleTypeTool, resolveTypeAtTurnStart, setTypeToolDef, toolsForType, typeFromTool, typeTitle, typeToolName, typedEnabled } from "./typed-prompt.js";
export { MAX_TOOL_ROUNDS, runDomainAgent, type TurnOptions } from "./agent.js";
export {
  createSession,
  deleteSession,
  ensureSession,
  freshenCompletion,
  getSession,
  getUsageStats,
  initSessions,
  isCompleted,
  listSessions,
  markCompleted,
  planTokens,
  purgeExpiredSessions,
  pushMessage,
  recordUsage,
  sanitizeHistory,
  saveSession,
  sessionCount,
  sessionHistory,
  sessionPlanTokens,
  sessionTotalTokens,
  sessionUsageSummary,
  setSessionAuth,
  userIdFromToken,
  type Session,
  type SessionSummary,
} from "./session.js";
export { closeStores, eventTap, getCounterStore, initStores, mongoSessions, recordEvent, recordUsageEvent, storeState, type CounterStore, type LedgerEvent, type UsageEvent, type WindowCount } from "./stores.js";
export { dedupeBlocks, dedupeSentences, extractUiBlocks, humanise, linkAllowed, rowsFromSlots, sanitizeUi, splitUi, visibleSoFar } from "./ui-blocks.js";
export { canonicalPick, formEcho, formReply, looksLikeFormReply, missingRows, parseFormReply, validateFormValues } from "./forms.js";
export { CONFIRM_WORDS, NEUTRAL, REFUSE_WORDS, SOFT_ACK, VALUE_NOUNS, extendLexicon, isPlainNo, isPlainSkip, isPlainYes, isQuestionShaped, wordsOf } from "./reply-words.js";
export { DEFAULT_UNITS, allWordsIn, norm, readAmount, readChoice, readNumber, readYesNo, type AmountRead, type ChoiceRead, type YesNoRead } from "./readers.js";
export { DRAFT_TOOL, SLOT_CAP, WRITE_TOOL, detectCompletion, detectPreview, draftFingerprint } from "./preview.js";
export { attestNote, attestedListGuard, guardCreate, isCreateYes, type AttestResult } from "./guards.js";
export { EDIT_LEAD, NOTHING_VALUE, OTHER_VALUE, readEdit, sectionPickerBlock, sectionPickerLead, sectionPickerStill, sectionValue, updatedLine, type EditRead, type SectionDef } from "./sections.js";
export {
  CHANGE_VALUE,
  CONFIRM_VALUE,
  SKIP_VALUE,
  SUMMARY_LEAD,
  allStepsEnded,
  carryStepValues,
  draftOf,
  drawStep,
  finalizeTurn,
  loadDomainSteps,
  makeContext,
  nextOwed,
  openAskUi,
  openStep,
  registerSteps,
  registeredSteps,
  resetDependents,
  stepNotes,
  stepState,
  stepTurn,
  stepsFor,
  summaryCard,
  summaryDue,
  type PreTurn,
} from "./steps/engine.js";
export type { RuntimeTurn, StepContext, StepDefinition, StepDraw, StepRead, StepSettled, StepVia } from "./steps/types.js";
export * as stepHelpers from "./steps/helpers.js";
