// Lessons (docs/autonomy.md "Lessons"): short, imperative notes extracted
// from adjudications, escalations, retros, or written directly, injected
// into packets and reviewer briefs for the matching task class and actor.
// This is the only path by which a lesson changes behaviour - nothing
// rewrites a prompt file automatically.

import { insertLesson, getLesson, listLessons as listLessonsLedger, setLessonStatus } from './ledger.mjs';

export const VALID_SOURCES = new Set(['adjudication', 'escalation', 'retro', 'agent', 'human']);
export const VALID_APPLIES_TO = new Set(['builder', 'reviewer', 'architect', 'all']);

function invalid(message) {
  const e = new Error(message);
  e.code = 1;
  return e;
}

export function add(db, fields) {
  if (!VALID_SOURCES.has(fields.source)) {
    throw invalid(`source must be one of ${[...VALID_SOURCES].join(', ')}, got ${fields.source}`);
  }
  const appliesTo = fields.appliesTo ?? 'all';
  if (!VALID_APPLIES_TO.has(appliesTo)) {
    throw invalid(`applies_to must be one of ${[...VALID_APPLIES_TO].join(', ')}, got ${appliesTo}`);
  }
  if (!fields.lesson) throw invalid('lesson text is required');

  return insertLesson(db, {
    source: fields.source,
    task_id: fields.taskId,
    business_id: fields.businessId,
    task_class: fields.taskClass,
    applies_to: appliesTo,
    lesson: fields.lesson,
    evidence: fields.evidence,
    confidence: fields.confidence !== undefined && fields.confidence !== null ? Number(fields.confidence) : 0.5,
  });
}

export function list(db, { taskClass, appliesTo, status } = {}) {
  return listLessonsLedger(db, { taskClass, appliesTo, status });
}

export function retire(db, { id, reason }) {
  const existing = getLesson(db, id);
  if (!existing) throw invalid(`no such lesson: ${id}`);
  return setLessonStatus(db, id, 'retired', { retiredReason: reason });
}

/**
 * Selection for injection (docs/autonomy.md "Injection"): active lessons
 * where task_class matches or is null, and applies_to matches `actor` or is
 * 'all', ordered by confidence desc then recency desc, limited to
 * config.autonomy.lessons_per_packet.
 */
export function selectForPacket(db, config, { taskClass, actor } = {}) {
  const active = listLessonsLedger(db, { status: 'active' });
  const limit = config.autonomy.lessons_per_packet;
  return active
    .filter((l) => (l.task_class == null || l.task_class === taskClass) && (l.applies_to === 'all' || l.applies_to === actor))
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
    })
    .slice(0, limit);
}
