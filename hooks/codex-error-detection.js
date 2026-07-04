"use strict";

const { extractAssistantTextFromRecord, isTurnBoundaryRecord } = require("./codex-assistant-output");

const CODEX_API_ERROR_TYPES = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "billing_error",
  "rate_limit",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
]);

const CODEX_API_ERROR_TEXT_RE =
  /^\s*(api\s+error|openai\s+api\s+error|request\s+failed|model\s+request\s+failed)\b/i;

function normalizeCodexApiErrorType(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (CODEX_API_ERROR_TYPES.has(text)) return text;
  if (!text) return "unknown";
  if (/rate|429/.test(text)) return "rate_limit";
  if (/auth|oauth|unauthori[sz]ed|forbidden|401|403/.test(text)) return "authentication_failed";
  if (/billing|quota|credit|payment/.test(text)) return "billing_error";
  if (/invalid|bad_request|400/.test(text)) return "invalid_request";
  if (/model.*not|not.*model|404/.test(text)) return "model_not_found";
  if (/max.*output|output.*token/.test(text)) return "max_output_tokens";
  if (/server|overload|internal|timeout|5\d\d|500|502|503|504/.test(text)) return "server_error";
  return "unknown";
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function recordPayload(record) {
  return record && record.payload && typeof record.payload === "object" ? record.payload : {};
}

function recordHasApiErrorFlag(record) {
  const payload = recordPayload(record);
  return record && record.isApiErrorMessage === true
    || payload.isApiErrorMessage === true
    || payload.error_present === true
    || payload.api_error === true;
}

function recordHasStructuredErrorMetadata(record) {
  const payload = recordPayload(record);
  return [
    "api_error_type",
    "apiErrorType",
    "error_type",
    "errorType",
    "error_code",
    "errorCode",
    "error",
  ].some((key) => Object.prototype.hasOwnProperty.call(payload, key)
    || Object.prototype.hasOwnProperty.call(record || {}, key));
}

function structuredApiErrorCandidate(record) {
  if (!record || typeof record !== "object") return null;
  const payload = recordPayload(record);
  const reason = firstString(
    payload.api_error_type,
    payload.apiErrorType,
    payload.error_type,
    payload.errorType,
    payload.error_code,
    payload.errorCode,
    payload.error,
    payload.reason,
    record.api_error_type,
    record.error_type,
    record.errorType,
    record.error,
    record.reason
  );
  const status = firstString(payload.status, record.status);
  const message = firstString(
    payload.error_message,
    payload.errorMessage,
    payload.message,
    payload.description,
    record.error_message,
    record.message
  );
  const combined = [reason, status, message].filter(Boolean).join(" ");
  if (!combined) return null;
  if (/^interrupted$/i.test(reason)) return null;
  if (!/(api|rate|auth|oauth|billing|quota|invalid|model|server|overload|timeout|429|5\d\d|failed|failure|error)/i.test(combined)) {
    return null;
  }
  return { api_error_type: normalizeCodexApiErrorType(reason || message || status) };
}

function recordLooksLikeCodexApiError(record) {
  const payload = recordPayload(record);
  if (recordHasApiErrorFlag(record)) {
    return structuredApiErrorCandidate(record) || { api_error_type: "unknown" };
  }

  const structured = structuredApiErrorCandidate(record);
  if (
    structured
    && (payload.type === "turn_aborted" || recordHasStructuredErrorMetadata(record))
  ) {
    return structured;
  }

  const assistantText = extractAssistantTextFromRecord(record);
  if (assistantText && CODEX_API_ERROR_TEXT_RE.test(assistantText)) {
    return { api_error_type: normalizeCodexApiErrorType(assistantText) };
  }
  return null;
}

function responseItemLooksAssistantText(record) {
  const payload = recordPayload(record);
  if (record.type === "event_msg" && payload.type === "agent_message") return true;
  if (record.type !== "response_item") return false;
  const role = typeof payload.role === "string" ? payload.role.toLowerCase() : "";
  return role === "assistant" || payload.type === "message";
}

function extractCodexApiErrorFromRecords(records) {
  if (!Array.isArray(records) || !records.length) return null;

  let errorIndex = -1;
  let errorInfo = null;
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    const candidate = recordLooksLikeCodexApiError(record);
    if (candidate) {
      errorIndex = i;
      errorInfo = candidate;
      break;
    }
    if (isTurnBoundaryRecord(record)) break;
  }
  if (errorIndex < 0) return null;

  for (let i = errorIndex + 1; i < records.length; i++) {
    const record = records[i];
    if (isTurnBoundaryRecord(record)) return null;
    if (responseItemLooksAssistantText(record) && !recordLooksLikeCodexApiError(record)) return null;
  }
  return errorInfo || { api_error_type: "unknown" };
}

function codexToolOutputHasFailure(output) {
  if (typeof output !== "string" || !output) return false;
  const exitMatch = output.match(/\b(?:process\s+)?exited with code\s+(-?\d+)\b/i)
    || output.match(/\bexit code:\s*(-?\d+)\b/i);
  if (exitMatch) return Number(exitMatch[1]) !== 0;
  return /^apply_patch verification failed:/i.test(output.trim());
}

function codexRecordHasToolFailure(record) {
  if (!record || typeof record !== "object") return false;
  const payload = recordPayload(record);
  const key = payload.type ? `${record.type}:${payload.type}` : record.type;

  if (key === "event_msg:patch_apply_end") {
    return payload.success === false || payload.status === "failed" || payload.status === "error";
  }
  if (key === "event_msg:exec_command_end") {
    if (payload.success === false || payload.status === "failed" || payload.status === "error") return true;
    const exitCode = Number(payload.exit_code ?? payload.exitCode ?? payload.code);
    return Number.isFinite(exitCode) && exitCode !== 0;
  }
  if (key === "response_item:function_call_output" || key === "response_item:custom_tool_call_output") {
    return codexToolOutputHasFailure(payload.output);
  }
  return false;
}

module.exports = {
  CODEX_API_ERROR_TYPES,
  codexRecordHasToolFailure,
  codexToolOutputHasFailure,
  extractCodexApiErrorFromRecords,
  normalizeCodexApiErrorType,
};
