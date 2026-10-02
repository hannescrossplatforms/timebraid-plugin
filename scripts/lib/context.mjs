const SKILL = 'timebraid:time-tracking'

const NOT_CONNECTED = {
  'missing-token': 'no token is set',
  'bad-token': 'the token is not a Timebraid token',
  'bad-url': 'the server address is not a valid URL',
  'insecure-url': 'the server address must use https'
}

const label = (state) => `"${state.task}" in ${state.workspace} / ${state.project}`

function hintText({ rule, place }) {
  if (rule) {
    const project = rule.project ? `, project "${rule.project}"` : ''
    return ` The .timebraid.json in ${rule.folder} says: workspace "${rule.workspace}"${project}. Use it unless the request is clearly about something else.`
  }
  if (place) {
    return ` Last time in ${place.folder} this was tracked to ${place.workspace} / ${place.project} (workspace id ${place.workspaceId}, project id ${place.projectId}). Use it only if this request is about the same work.`
  }
  return ''
}

export function notConnected(problem) {
  return `Timebraid time tracking is installed but not connected: ${NOT_CONNECTED[problem] ?? 'its settings are incomplete'}. Mention this once, in one sentence: the user can create a token in Timebraid under Settings, Account, AI assistants, then run /plugin configure timebraid@timebraid. Then carry on with the request without tracking.`
}

export function startTracking(hints) {
  return `Timebraid tracks the time of every Claude Code thread. No timer is running for this thread yet. Before you start on the user's first request, start one with the ${SKILL} skill: choose the workspace and project, then call start_timer.${hintText(hints)}`
}

export function reminder(hints) {
  return `No Timebraid timer is running for this thread yet. Start one now with the ${SKILL} skill before you work on this request, unless the user said not to track this thread.${hintText(hints)}`
}

export function tracking(state) {
  return `This thread is tracked in Timebraid: ${label(state)}, entry ${state.entryId}. Keep working; do not start another timer for the same work.`
}

export function paused(state) {
  return `This thread was tracked in Timebraid as ${label(state)}. Its timer stopped while the thread was quiet or closed, and a new one starts on the same task with the next message.`
}

export function off() {
  return 'Time tracking is off for this thread. Start it again with /timebraid:track only if the user asks.'
}
