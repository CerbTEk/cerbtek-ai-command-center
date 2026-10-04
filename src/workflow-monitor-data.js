// Read-only projections of recorded workflow data. This module does not infer
// execution outcomes from approvals, request execution, confidence, or budgets.
export const WORKFLOW_MONITOR_WINDOWS = Object.freeze([7, 30, 90])
const DAY_MS = 24 * 60 * 60 * 1000
const TERMINAL_STATUSES = new Set(['Success', 'Error', 'Failed', 'Canceled'])
const REQUEST_STATUSES = new Set(['Pending', 'Approved', 'Rejected', 'Executing', 'Executed', 'Failed'])

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = value => typeof value === 'string' && value.trim() ? value : null
const textValue = value => typeof value === 'string' ? value : null
const statusValue = value => typeof value === 'string' && value.trim() ? value : null

export function timestampMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : null
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const timestamp = value => {
  const ms = timestampMs(value)
  return ms === null ? null : new Date(ms).toISOString()
}

export function workflowRunCategory(status) {
  if (status === 'Success') return 'success'
  if (status === 'Error' || status === 'Failed') return 'error'
  if (status === 'Running') return 'active'
  if (status === 'Waiting Approval') return 'waiting'
  if (status === 'Queued') return 'queued'
  if (status === 'Canceled') return 'canceled'
  return 'unknown'
}

export function workflowMonitorWindow(days = 30, now = Date.now()) {
  if (!WORKFLOW_MONITOR_WINDOWS.includes(days)) throw new RangeError('Choose a 7, 30, or 90 day window.')
  const endMs = timestampMs(now)
  if (endMs === null) throw new TypeError('A valid current timestamp is required.')
  const endDate = new Date(endMs)
  const startMs = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()) - (days - 1) * DAY_MS
  return { days, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), startMs, endMs, timeZone: 'UTC' }
}

function scopedRows(rows, organizationId) {
  if (!organizationId || !Array.isArray(rows)) return []
  const ids = new Set()
  return rows.filter(row => {
    if (!isRecord(row) || row.organization_id !== organizationId || !identifier(row.id) || ids.has(row.id)) return false
    ids.add(row.id)
    return true
  })
}

function exactStatusCounts(rows) {
  const counts = new Map()
  for (const row of rows) {
    const status = row.status ?? 'Unknown'
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  return Object.fromEntries(counts)
}

function completedDuration(row) {
  if (!TERMINAL_STATUSES.has(row.status)) return null
  const start = timestampMs(row.started_at)
  const end = timestampMs(row.completed_at)
  return start !== null && end !== null && end >= start ? end - start : null
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null
  const index = (sorted.length - 1) * fraction
  const lower = Math.floor(index)
  const remainder = index - lower
  return sorted[lower] + (sorted[Math.ceil(index)] - sorted[lower]) * remainder
}

export function summarizeWorkflowRuns(runs, available = Array.isArray(runs)) {
  const rows = Array.isArray(runs) ? runs : []
  const count = status => available ? rows.filter(row => row.status === status).length : null
  const durations = rows.map(completedDuration).filter(value => value !== null).sort((a, b) => a - b)
  const successCount = count('Success')
  const errorCount = count('Error')
  const failedCount = count('Failed')
  const terminalCount = available ? successCount + errorCount + failedCount : null
  return {
    totalRuns: available ? rows.length : null,
    statusCounts: available ? exactStatusCounts(rows) : null,
    successCount,
    errorCount,
    failedCount,
    terminalCount,
    successRate: terminalCount ? successCount / terminalCount : null,
    successRateDenominator: terminalCount,
    successRateDefinition: 'Success / (Success + Error + Failed)',
    activeCount: available ? rows.filter(row => workflowRunCategory(row.status) === 'active').length : null,
    waitingCount: available ? rows.filter(row => workflowRunCategory(row.status) === 'waiting').length : null,
    queuedCount: count('Queued'),
    canceledCount: count('Canceled'),
    unknownCount: available ? rows.filter(row => workflowRunCategory(row.status) === 'unknown').length : null,
    duration: {
      meanMs: available && durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
      p50Ms: available ? percentile(durations, 0.5) : null,
      p95Ms: available ? percentile(durations, 0.95) : null,
      sampleCount: available ? durations.length : null,
      definition: 'Completed elapsed time from started_at to completed_at for Success, Error, Failed, or Canceled runs; includes waiting time.',
      percentileMethod: 'Linear interpolation',
    },
  }
}

function summarizeRequests(rows, available) {
  const count = status => available ? rows.filter(row => row.status === status).length : null
  return {
    total: available ? rows.length : null,
    statusCounts: available ? exactStatusCounts(rows) : null,
    pendingCount: count('Pending'),
    approvedCount: count('Approved'),
    rejectedCount: count('Rejected'),
    executingCount: count('Executing'),
    executedCount: count('Executed'),
    failedCount: count('Failed'),
    unknownCount: available ? rows.filter(row => !REQUEST_STATUSES.has(row.status)).length : null,
  }
}

function byEventTime(a, b) {
  return a.eventMs - b.eventMs || a.id.localeCompare(b.id)
}

function inWindow(row, window) {
  return row.eventMs !== null && row.eventMs >= window.startMs && row.eventMs <= window.endMs
}

function runProjection(row) {
  const started_at = timestamp(row.started_at)
  const created_at = timestamp(row.created_at)
  const run = {
    id: row.id,
    organization_id: row.organization_id,
    workflow_id: row.workflow_id,
    status: statusValue(row.status),
    category: workflowRunCategory(row.status),
    current_step: Number.isInteger(row.current_step) && row.current_step >= 0 ? row.current_step : null,
    started_at,
    completed_at: timestamp(row.completed_at),
    created_at,
    event_at: created_at ?? started_at,
    eventMs: timestampMs(created_at ?? started_at),
    summary: textValue(row.summary),
    error_message: textValue(row.error_message),
  }
  return { ...run, durationMs: completedDuration(run) }
}

function requestProjection(row, workflowId, linkedRun) {
  const created_at = timestamp(row.created_at)
  return {
    id: row.id,
    organization_id: row.organization_id,
    workflow_id: workflowId,
    workflow_run_id: identifier(row.workflow_run_id),
    associatedRunStatus: linkedRun?.status ?? null,
    agent_id: identifier(row.agent_id),
    status: statusValue(row.status),
    action_type: textValue(row.action_type),
    title: textValue(row.title),
    summary: textValue(row.summary),
    error_message: textValue(row.error_message),
    created_at,
    approved_at: timestamp(row.approved_at),
    rejected_at: timestamp(row.rejected_at),
    executed_at: timestamp(row.executed_at),
    event_at: created_at,
    eventMs: timestampMs(created_at),
  }
}

function dailyTrend(rows, window, available) {
  const bins = Array.from({ length: window.days }, (_, index) => {
    const startMs = window.startMs + index * DAY_MS
    return {
      date: new Date(startMs).toISOString().slice(0, 10),
      start: new Date(startMs).toISOString(),
      end: new Date(Math.min(startMs + DAY_MS, window.endMs)).toISOString(),
      rows: [],
    }
  })
  for (const row of rows) {
    const index = Math.floor((row.eventMs - window.startMs) / DAY_MS)
    if (index >= 0 && index < bins.length) bins[index].rows.push(row)
  }
  return bins.map(({ rows: dayRows, ...bin }) => ({ ...bin, ...summarizeWorkflowRuns(dayRows, available) }))
}

/**
 * Builds a scoped, read-only snapshot from fetched records. Omitted/null sources
 * are unavailable; an empty fetched array is an observed zero. Counts cover only
 * the supplied records: callers must disclose loading limits or partial results.
 * Windows include today and days - 1 previous UTC calendar days, ending at now.
 * Runs are selected by created_at, falling back to started_at. Requests use
 * created_at. latestRun and history both respect the selected time window.
 */
export function buildWorkflowMonitor({ organizationId, workflows, runs, agentRequests, actions, schedules, days = 30, now = Date.now() } = {}) {
  const organization = identifier(organizationId)
  const window = workflowMonitorWindow(days, now)
  const sourceAvailability = {
    workflows: Boolean(organization) && Array.isArray(workflows),
    runs: Boolean(organization) && Array.isArray(workflows) && Array.isArray(runs),
    agentRequests: Boolean(organization) && Array.isArray(workflows) && Array.isArray(agentRequests),
    actions: Boolean(organization) && Array.isArray(workflows) && Array.isArray(runs) && Array.isArray(actions),
    schedules: Boolean(organization) && Array.isArray(workflows) && Array.isArray(schedules),
  }
  const definitions = scopedRows(workflows, organization).map(row => ({
    id: row.id,
    organization_id: row.organization_id,
    name: textValue(row.name),
    description: textValue(row.description),
    status: statusValue(row.status),
    trigger_type: textValue(row.trigger_type),
    stepCount: Array.isArray(row.steps) ? row.steps.length : null,
  }))
  const definitionIds = new Set(definitions.map(row => row.id))
  const scopedRuns = scopedRows(runs, organization).filter(row => definitionIds.has(row.workflow_id)).map(runProjection)
  const runById = new Map(scopedRuns.map(row => [row.id, row]))
  const history = scopedRuns.filter(row => inWindow(row, window)).sort(byEventTime)
  const allAgentRequests = scopedRows(agentRequests, organization).flatMap(row => {
    const linkedRun = runById.get(row.workflow_run_id)
    const workflowId = identifier(row.workflow_id) ?? linkedRun?.workflow_id
    if (!definitionIds.has(workflowId) || (linkedRun && linkedRun.workflow_id !== workflowId)) return []
    return [requestProjection(row, workflowId, linkedRun)]
  })
  const allActions = scopedRows(actions, organization).flatMap(row => {
    const linkedRun = runById.get(row.workflow_run_id)
    return linkedRun ? [requestProjection(row, linkedRun.workflow_id, linkedRun)] : []
  })
  const selectedAgentRequests = allAgentRequests.filter(row => inWindow(row, window)).sort(byEventTime)
  const selectedActions = allActions.filter(row => inWindow(row, window)).sort(byEventTime)
  const scopedSchedules = scopedRows(schedules, organization).filter(row => definitionIds.has(row.workflow_id)).map(row => ({
    id: row.id,
    organization_id: row.organization_id,
    workflow_id: row.workflow_id,
    name: textValue(row.name),
    active: typeof row.active === 'boolean' ? row.active : null,
    last_run_at: timestamp(row.last_run_at),
    next_run_at: timestamp(row.next_run_at),
    cron_expression: textValue(row.cron_expression),
    timezone: textValue(row.timezone),
  }))

  return {
    window,
    sourceAvailability,
    history,
    totals: summarizeWorkflowRuns(history, sourceAvailability.runs),
    trend: dailyTrend(history, window, sourceAvailability.runs),
    agentMetrics: summarizeRequests(selectedAgentRequests, sourceAvailability.agentRequests),
    actionMetrics: summarizeRequests(selectedActions, sourceAvailability.actions),
    // Same-organization records without sufficient linkage or timestamps are
    // disclosed as unassigned/undated, never assigned to an arbitrary workflow.
    coverage: {
      undatedRunCount: sourceAvailability.runs ? scopedRuns.filter(row => row.eventMs === null).length : null,
      unassociatedActionCount: sourceAvailability.actions ? scopedRows(actions, organization).filter(row => !runById.has(row.workflow_run_id)).length : null,
    },
    workflows: definitions.map(workflow => {
      const workflowHistory = history.filter(row => row.workflow_id === workflow.id)
      const workflowAgentRequests = selectedAgentRequests.filter(row => row.workflow_id === workflow.id)
      const workflowActions = selectedActions.filter(row => row.workflow_id === workflow.id)
      return {
        workflow,
        metrics: summarizeWorkflowRuns(workflowHistory, sourceAvailability.runs),
        history: workflowHistory,
        latestRun: workflowHistory.at(-1) ?? null,
        trend: dailyTrend(workflowHistory, window, sourceAvailability.runs),
        agentRequests: workflowAgentRequests,
        agentMetrics: summarizeRequests(workflowAgentRequests, sourceAvailability.agentRequests),
        actions: workflowActions,
        actionMetrics: summarizeRequests(workflowActions, sourceAvailability.actions),
        schedules: scopedSchedules.filter(row => row.workflow_id === workflow.id),
        undatedRunCount: sourceAvailability.runs ? scopedRuns.filter(row => row.workflow_id === workflow.id && row.eventMs === null).length : null,
      }
    }),
  }
}

export function formatElapsed(milliseconds) {
  if (milliseconds === null || milliseconds === undefined || typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return 'Unavailable'
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)} s`
  if (milliseconds < 3600000) return `${(milliseconds / 60000).toFixed(1)} min`
  return `${(milliseconds / 3600000).toFixed(1)} h`
}
