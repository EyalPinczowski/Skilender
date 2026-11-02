import {
  addDays,
  classifyEvents,
  colorIdForTask,
  compareDates,
  localDateOf,
  parseTime,
  zonedTimeToUtc,
  type Block,
  type CalendarEvent,
} from '@upversion/shared';
import { CalendarCryptoError, type CalendarTokenCrypto } from '../../calendar-crypto';
import type { Database } from '../../db/database';
import { HttpError } from '../../errors';
import type { SchedulingService } from '../scheduling/service';
import {
  CalendarAuthError,
  CalendarRequestError,
  CalendarRetryableError,
  CalendarSyncTokenExpiredError,
} from './errors';
import { eventIdFor } from './event-id';
import type { CalendarProvider } from './provider';
import {
  syncRepo,
  type ActivePlan,
  type BusyInsert,
  type LinkRow,
  type LockedRow,
  type SyncSource,
} from './sync-repo';
import { CalendarWriteRefused, createWriteGuard, type WriteGuard } from './write-guard';

/**
 * The calendar sync engine (spec 3.8). Two halves that never depend on each other succeeding:
 *
 *  READ  Busy time from the calendars that block time (view-only). Each source keeps Google's sync
 *        token and is read incrementally; its rows in `calendar_busy` are replaced, with title and
 *        times only. The app's own calendar is never read as busy.
 *  WRITE The next days of planned blocks are mirrored into the app's own calendar, only through
 *        the write guard. Each block key maps to one deterministic event id, so repeats never
 *        duplicate. A block the user moved or deleted in the calendar becomes a locked block (the
 *        scheduler plans around the user's decision) and the schedule is recomputed once.
 *
 * The schedule itself is computed on demand from the plan plus these tables, so a failed sync
 * leaves every scheduling path working on the last data that was stored. Google calls never run
 * inside a database transaction. Nothing sensitive is logged: no token, no event title.
 */

/** A sync younger than this is answered from the stored data without calling Google. */
export const SYNC_THROTTLE_MS = 5 * 60 * 1000;
/** `force` skips the throttle, but not more than once in this time. */
export const FORCE_MIN_INTERVAL_MS = 60 * 1000;
/** How many days of planned blocks are mirrored into the app calendar. */
export const WRITE_DAYS = 14;
/** Busy time is read this far ahead when the plan has no end date. */
export const DEFAULT_READ_DAYS = 120;
/** A full listing reads this much beyond what is needed, so the token stays valid for weeks. */
const WINDOW_SLACK_DAYS = 30;
const MAX_PAGES = 40;
const MAX_EXTRA_PASSES = 2;
const MAX_ACTIVE_PLANS = 5;
const MAX_INSERT_GENERATIONS = 3;
const TITLE_MAX = 300;

export interface SyncResult {
  /** `cached` when the throttle answered from stored data and Google was not called. */
  status: 'synced' | 'cached';
  syncedAt: string | null;
  movedTaskIds: string[];
  finishChanged: boolean;
  text: string;
}

export interface CalendarSyncOptions {
  db: Database;
  crypto: CalendarTokenCrypto;
  providerFor: (refreshToken: string) => CalendarProvider;
  markNeedsReconnect: (userId: string, code: string) => Promise<void>;
  scheduling: Pick<SchedulingService, 'getSchedule' | 'calendarImpact'>;
  /** Only non-sensitive fields are ever passed. */
  log: { warn(obj: object, msg: string): void };
  now?: () => Date;
}

const reconnectRequired = () =>
  new HttpError(
    409,
    'calendar_reconnect_required',
    'Google no longer accepts the calendar connection. Reconnect your calendar.',
  );

const SAFE_CODE = /^[A-Za-z0-9_.-]{1,100}$/;
const safeCode = (code: string) => (SAFE_CODE.test(code) ? code : 'auth_error');

const clean = (text: string | undefined, max: number) =>
  (text ?? '').replaceAll('\u0000', '').slice(0, max);

/** One planned block that should exist as an event. */
export interface DesiredBlock {
  key: string;
  taskId: string;
  start: Date;
  end: Date;
  summary: string;
  colorId: string;
}

/**
 * The blocks to mirror: open tasks only, from `today` to `horizon`. A block's key is
 * `${taskId}:${date}:${ordinal}` (ordinal = position among the task's blocks of that day).
 * A locked block keeps the key of the locked row it comes from, so moving it never renames it.
 */
export function desiredBlocks(input: {
  blocks: Block[];
  tasks: Map<string, { title: string; open: boolean; orderIndex: number }>;
  locked: LockedRow[];
  today: string;
  horizon: string;
  timeZone: string;
}): Map<string, DesiredBlock> {
  const { tasks, today, horizon, timeZone } = input;
  const lockedKey = new Map(
    input.locked
      .filter((r) => r.reason === 'moved')
      .map((r) => [`${r.task_id}|${r.starts_at.getTime()}`, r.block_key]),
  );
  const reserved = new Set(input.locked.map((r) => r.block_key));
  const inRange = input.blocks
    .filter(
      (b) =>
        compareDates(b.date, today) >= 0 &&
        compareDates(b.date, horizon) <= 0 &&
        tasks.get(b.taskId)?.open === true,
    )
    .sort(
      (a, b) =>
        compareDates(a.date, b.date) ||
        parseTime(a.start) - parseTime(b.start) ||
        (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0),
    );
  const out = new Map<string, DesiredBlock>();
  const counters = new Map<string, number>();
  for (const b of inRange) {
    const start = zonedTimeToUtc(b.date, parseTime(b.start), timeZone);
    const end = zonedTimeToUtc(b.date, parseTime(b.end), timeZone);
    if (!(end.getTime() > start.getTime())) continue;
    let key = b.kind === 'locked' ? lockedKey.get(`${b.taskId}|${start.getTime()}`) : undefined;
    if (!key) {
      // Ordinals skip keys that belong to a locked row, so a block never takes over the key (and
      // so the event) of a block the user moved or deleted.
      const slot = `${b.taskId}:${b.date}`;
      let n = counters.get(slot) ?? 0;
      while (reserved.has(`${slot}:${n}`) || out.has(`${slot}:${n}`)) n += 1;
      counters.set(slot, n + 1);
      key = `${slot}:${n}`;
    }
    if (out.has(key)) continue;
    out.set(key, {
      key,
      taskId: b.taskId,
      start,
      end,
      summary: clean(tasks.get(b.taskId)!.title, TITLE_MAX),
      colorId: colorIdForTask(tasks.get(b.taskId)!.orderIndex),
    });
  }
  return out;
}

const instantOf = (t: { dateTime?: string | undefined } | undefined): number | null => {
  const ms = t?.dateTime ? Date.parse(t.dateTime) : NaN;
  return Number.isNaN(ms) ? null : ms;
};

interface Running {
  rerun: boolean;
}

export function createCalendarSync(options: CalendarSyncOptions) {
  const { db, crypto, scheduling, log } = options;
  const now = options.now ?? (() => new Date());
  /** Users with a sync in progress in this process. See the note on `acquire`. */
  const running = new Map<string, Running>();
  /** Background runs started by `afterReschedule`, so a caller (or a test) can wait for them. */
  const background = new Set<Promise<void>>();

  // ---------------------------------------------------------------------------------- errors

  const failureCode = (error: unknown): string => (error instanceof Error ? error.name : 'unknown');

  /**
   * Turns a failure into a client answer. Credentials that no longer work flag the connection and
   * keep all data; a retryable failure and an unexpected answer only record a short code.
   * Anything else (a database error can echo row values) is reduced to its name before it leaves.
   */
  async function toHttpError(userId: string, error: unknown): Promise<Error> {
    if (error instanceof HttpError) return error;
    if (error instanceof CalendarAuthError) {
      await flagReconnect(userId, safeCode(error.code));
      return reconnectRequired();
    }
    if (error instanceof CalendarCryptoError) {
      await flagReconnect(userId, 'token_unreadable');
      return reconnectRequired();
    }
    if (error instanceof CalendarRetryableError) {
      await recordError(userId, 'unavailable');
      const seconds = Math.min(3600, Math.max(1, Math.ceil((error.retryAfterMs ?? 60_000) / 1000)));
      return new HttpError(
        503,
        'calendar_unavailable',
        'Google Calendar is not reachable. Try again later.',
        undefined,
        { 'retry-after': String(seconds) },
      );
    }
    if (error instanceof CalendarRequestError || error instanceof CalendarSyncTokenExpiredError) {
      await recordError(userId, 'google_error');
      return new HttpError(502, 'calendar_error', 'Google Calendar returned an unexpected answer.');
    }
    log.warn({ reason: failureCode(error) }, 'calendar sync failed unexpectedly');
    await recordError(userId, 'sync_failed');
    return new HttpError(502, 'calendar_error', 'The calendar sync did not finish.');
  }

  /** Flags the connection. A database error here must not replace the answer (it can echo data). */
  async function flagReconnect(userId: string, code: string): Promise<void> {
    try {
      await options.markNeedsReconnect(userId, code);
    } catch (error) {
      log.warn({ reason: failureCode(error) }, 'calendar connection was not flagged for reconnect');
    }
  }

  async function recordError(userId: string, code: string): Promise<void> {
    try {
      await db.withUser(userId, (ctx) => syncRepo.setLastError(ctx, userId, code));
    } catch {
      // Recording the code is a courtesy; the original failure is what matters.
    }
  }

  // ---------------------------------------------------------------------------------- read side

  async function listAll(
    provider: CalendarProvider,
    calendarId: string,
    timeMin: string | null,
    timeMax: string | null,
    syncToken?: string,
  ): Promise<{ events: CalendarEvent[]; token: string | null }> {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await provider.listEvents(calendarId, timeMin, timeMax, {
        ...(syncToken ? { syncToken, showDeleted: true } : {}),
        ...(pageToken ? { pageToken } : {}),
      });
      events.push(...result.events);
      if (!result.nextPageToken) return { events, token: result.nextSyncToken };
      pageToken = result.nextPageToken;
    }
    throw new CalendarRequestError('too_many_events', null);
  }

  async function syncSource(
    userId: string,
    provider: CalendarProvider,
    source: SyncSource,
    timeZone: string,
    from: string,
    wantedEnd: string,
  ): Promise<void> {
    const covers =
      source.sync_token !== null &&
      source.window_start !== null &&
      source.window_end !== null &&
      compareDates(source.window_start, from) <= 0 &&
      compareDates(source.window_end, wantedEnd) >= 0;

    let listing: { events: CalendarEvent[]; token: string | null } | null = null;
    let full = !covers;
    if (covers) {
      try {
        listing = await listAll(provider, source.calendar_id, null, null, source.sync_token!);
      } catch (error) {
        // 410: the token is too old. Drop it and read this source from scratch.
        if (!(error instanceof CalendarSyncTokenExpiredError)) throw error;
        full = true;
      }
    }
    let windowEnd = source.window_end ?? wantedEnd;
    if (full || listing === null) {
      windowEnd = addDays(wantedEnd, WINDOW_SLACK_DAYS);
      listing = await listAll(
        provider,
        source.calendar_id,
        zonedTimeToUtc(from, 0, timeZone).toISOString(),
        zonedTimeToUtc(addDays(windowEnd, 1), 0, timeZone).toISOString(),
      );
    }

    await db.withUser(userId, async (ctx) => {
      // The user's "this all-day event blocks the day" marks survive the replacement.
      const blockingEventIds = await syncRepo.blockingIds(ctx, userId, source.calendar_id);
      const results = classifyEvents(listing!.events, { timeZone, blockingEventIds });
      const inRange = (date: string) =>
        compareDates(date, from) >= 0 && compareDates(date, windowEnd) <= 0;
      const rows: BusyInsert[] = [];
      for (const r of results) {
        if (r.eventId.length > 500) continue;
        const title = clean(r.title, TITLE_MAX);
        if (r.kind === 'busy' || r.kind === 'tentative') {
          for (const i of r.intervals) {
            if (!inRange(i.date)) continue;
            rows.push({
              date: i.date,
              externalEventId: r.eventId,
              startMinute: i.startMinute,
              endMinute: i.endMinute,
              title,
              kind: r.kind,
              blocksDay: false,
            });
          }
        } else if (r.kind === 'all_day') {
          for (const date of r.days ?? []) {
            if (!inRange(date)) continue;
            rows.push({
              date,
              externalEventId: r.eventId,
              startMinute: 0,
              endMinute: 1440,
              title,
              kind: 'all_day',
              blocksDay: r.blocksDay === true,
            });
          }
        }
      }
      await syncRepo.applySource(ctx, userId, source.calendar_id, {
        replaceAll: full,
        touchedIds: listing!.events.map((e) => e.id),
        rows,
        keepFrom: from,
        syncToken: listing!.token,
        window: full ? { start: from, end: windowEnd } : null,
      });
    });
  }

  /** Reads every source that blocks time; sources that do not block time lose their rows. */
  async function readSide(
    userId: string,
    provider: CalendarProvider,
    appCalendarId: string | null,
    plans: ActivePlan[],
    timeZone: string,
    today: string,
  ): Promise<void> {
    const knownZone = await db.withUser(userId, (ctx) => syncRepo.syncTimezone(ctx, userId));
    let sources = await db.withUser(userId, (ctx) => syncRepo.sources(ctx, userId));
    if (knownZone !== null && knownZone !== timeZone) {
      // Busy rows are minutes of a local date: in another zone they mean something else.
      await db.withUser(userId, (ctx) => syncRepo.clearAllBusy(ctx, userId));
      sources = sources.map((s) => ({
        ...s,
        sync_token: null,
        window_start: null,
        window_end: null,
      }));
    }
    const from = addDays(today, -1);
    const ends = plans
      .map((p) => p.end_date)
      .filter((d): d is string => d !== null && compareDates(d, today) >= 0);
    const wantedEnd =
      ends.length > 0
        ? ends.reduce((a, b) => (compareDates(a, b) >= 0 ? a : b))
        : addDays(today, DEFAULT_READ_DAYS);

    // The app's own calendar is never busy time, whatever the stored choice says.
    const counts = (s: SyncSource) => s.blocks_time && s.calendar_id !== appCalendarId;
    await db.withUser(userId, (ctx) =>
      syncRepo.dropSources(
        ctx,
        userId,
        sources.filter((s) => !counts(s)).map((s) => s.calendar_id),
      ),
    );
    for (const source of sources.filter(counts)) {
      await syncSource(userId, provider, source, timeZone, from, wantedEnd);
    }
    await db.withUser(userId, (ctx) => syncRepo.setSyncTimezone(ctx, userId, timeZone));
  }

  // ---------------------------------------------------------------------------------- write side

  interface WriteEnv {
    userId: string;
    provider: CalendarProvider;
    guard: WriteGuard;
    appCalendarId: string;
  }

  type LinkOp = { op: 'upsert'; link: LinkRow } | { op: 'delete'; key: string };

  const timeOf = (d: Date, timeZone: string) => ({ dateTime: d.toISOString(), timeZone });

  /** Looks at our own events for the user's edits and records them as locked blocks. */
  async function detectEdits(
    env: WriteEnv,
    links: LinkRow[],
    desired: Map<string, DesiredBlock>,
    today: string,
    horizon: string,
    timeZone: string,
  ): Promise<{ locks: LockedRow[]; touchedLinks: LinkOp[] }> {
    const nowMs = now().getTime();
    const managed = links.filter((l) => l.last_end.getTime() > nowMs);
    const result = { locks: [] as LockedRow[], touchedLinks: [] as LinkOp[] };
    if (managed.length === 0) return result;

    // One listing of the app calendar covers the window; a link missing from it is fetched alone
    // (the user may have moved its event out of the window).
    const byId = new Map<string, CalendarEvent>();
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listed = await env.provider.listEvents(
        env.appCalendarId,
        zonedTimeToUtc(addDays(today, -1), 0, timeZone).toISOString(),
        zonedTimeToUtc(addDays(horizon, 2), 0, timeZone).toISOString(),
        { showDeleted: true, ...(pageToken ? { pageToken } : {}) },
      );
      for (const e of listed.events) byId.set(e.id, e);
      if (!listed.nextPageToken) break;
      pageToken = listed.nextPageToken;
    }

    for (const link of managed) {
      const exists = desired.has(link.block_key);
      let ev = byId.get(link.event_id);
      if (!ev) ev = (await env.provider.getEvent(env.appCalendarId, link.event_id)) ?? undefined;
      if (!ev || ev.status === 'cancelled') {
        // The user deleted the event. If its block is still planned, that time is unavailable.
        if (exists) {
          result.locks.push({
            block_key: link.block_key,
            task_id: link.task_id,
            starts_at: link.last_start,
            ends_at: link.last_end,
            reason: 'deleted',
          });
        }
        result.touchedLinks.push({ op: 'delete', key: link.block_key });
        continue;
      }
      const start = instantOf(ev.start);
      const end = instantOf(ev.end);
      if (start === null || end === null || end <= start) continue;
      if (start !== link.last_start.getTime() || end !== link.last_end.getTime()) {
        if (!exists) continue; // the block is gone; the event is deleted below
        const wanted = desired.get(link.block_key)!;
        if (start === wanted.start.getTime() && end === wanted.end.getTime()) {
          // Our own earlier change reached Google but its answer was lost: not a user edit.
          result.touchedLinks.push({
            op: 'upsert',
            link: {
              ...link,
              last_start: wanted.start,
              last_end: wanted.end,
              etag: ev.etag ?? link.etag,
            },
          });
          continue;
        }
        const startsAt = new Date(start);
        const endsAt = new Date(end);
        result.locks.push({
          block_key: link.block_key,
          task_id: link.task_id,
          starts_at: startsAt,
          ends_at: endsAt,
          reason: 'moved',
        });
        result.touchedLinks.push({
          op: 'upsert',
          link: { ...link, last_start: startsAt, last_end: endsAt, etag: ev.etag ?? link.etag },
        });
      }
    }
    return result;
  }

  /**
   * A lock whose block is gone (task done, day passed, block no longer planned) is removed, in
   * one statement. Returns the keys that were removed.
   */
  async function cleanLocks(
    userId: string,
    planId: string,
    locked: LockedRow[],
    tasks: Map<string, { title: string; open: boolean; orderIndex: number }>,
    blocks: Block[],
    timeZone: string,
  ): Promise<Set<string>> {
    const nowMs = now().getTime();
    const lockedStarts = new Set(
      blocks
        .filter((b) => b.kind === 'locked')
        .map(
          (b) => `${b.taskId}|${zonedTimeToUtc(b.date, parseTime(b.start), timeZone).getTime()}`,
        ),
    );
    const gone = locked.filter(
      (row) =>
        tasks.get(row.task_id)?.open !== true ||
        row.ends_at.getTime() <= nowMs ||
        // A moved block must still come out of the scheduler as a locked block.
        (row.reason === 'moved' && !lockedStarts.has(`${row.task_id}|${row.starts_at.getTime()}`)),
    );
    if (gone.length > 0) {
      const keys = gone.map((r) => r.block_key);
      await db.withUser(userId, (ctx) => syncRepo.deleteLockedMany(ctx, userId, planId, keys));
    }
    return new Set(gone.map((r) => r.block_key));
  }

  async function syncPlan(env: WriteEnv, plan: ActivePlan): Promise<void> {
    const { userId } = env;
    let schedule = await scheduling.getSchedule(userId, plan.id);
    const timeZone = schedule.timezone;
    const today = schedule.today;
    const horizon = addDays(today, WRITE_DAYS - 1);

    const load = () =>
      db.withUser(userId, async (ctx) => ({
        tasks: await syncRepo.openTasks(ctx, userId, plan.id),
        links: await syncRepo.links(ctx, userId, plan.id),
        locked: await syncRepo.locked(ctx, userId, plan.id),
      }));
    let state = await load();
    const desiredNow = () =>
      desiredBlocks({
        blocks: schedule.blocks,
        tasks: state.tasks,
        locked: state.locked,
        today,
        horizon,
        timeZone,
      });
    let desired = desiredNow();

    // Pass 1: did the user move or delete events of ours?
    const edits = await detectEdits(env, state.links, desired, today, horizon, timeZone);
    if (edits.locks.length > 0 || edits.touchedLinks.length > 0) {
      await db.withUser(userId, async (ctx) => {
        for (const lock of edits.locks) await syncRepo.upsertLocked(ctx, userId, plan.id, lock);
        for (const op of edits.touchedLinks) {
          if (op.op === 'delete') await syncRepo.deleteLink(ctx, userId, plan.id, op.key);
          else await syncRepo.upsertLink(ctx, userId, plan.id, op.link);
        }
      });
      // The single extra pass: the locks flow through loadCalendarInputs into a fresh schedule.
      state = await load();
      schedule = await scheduling.getSchedule(userId, plan.id);
      desired = desiredNow();
    }
    const removedLocks = await cleanLocks(
      userId,
      plan.id,
      state.locked,
      state.tasks,
      schedule.blocks,
      timeZone,
    );

    // Pass 2: bring the app calendar in line with the schedule.
    const ops: LinkOp[] = [];
    const nowMs = now().getTime();
    const keptMoved = new Set(
      state.locked
        .filter((r) => r.reason === 'moved' && !removedLocks.has(r.block_key))
        .map((r) => r.block_key),
    );
    const linkByKey = new Map(state.links.map((l) => [l.block_key, l]));
    let failure: unknown = null;
    try {
      for (const d of desired.values()) {
        if (d.end.getTime() <= nowMs) continue; // never write the past
        const link = linkByKey.get(d.key);
        if (!link) {
          const inserted = await insertBlock(env, plan.id, d, timeZone);
          if (inserted) ops.push({ op: 'upsert', link: inserted });
        } else if (
          link.last_start.getTime() !== d.start.getTime() ||
          link.last_end.getTime() !== d.end.getTime() ||
          link.last_summary !== d.summary ||
          link.last_color !== d.colorId
        ) {
          const patched = await patchBlock(env, link, d, timeZone);
          if (patched) ops.push({ op: 'upsert', link: patched });
        }
      }
      for (const link of state.links) {
        if (desired.has(link.block_key)) continue;
        if (link.last_end.getTime() <= nowMs) continue; // history stays
        // A block the user moved out of the window (beyond the 14 days) is still planned there:
        // its event stays where the user put it.
        if (keptMoved.has(link.block_key)) continue;
        try {
          await env.guard.deleteAppEvent(env.appCalendarId, link.event_id);
        } catch (error) {
          // The guard says the event is not ours to delete: leave it alone and forget the link.
          if (!(error instanceof CalendarWriteRefused)) throw error;
          log.warn({ reason: error.reason }, 'calendar event not deleted');
        }
        ops.push({ op: 'delete', key: link.block_key });
      }
    } catch (error) {
      failure = error;
    } finally {
      // What already happened in Google is recorded even when a later call failed.
      if (ops.length > 0) {
        await db.withUser(userId, async (ctx) => {
          for (const op of ops) {
            if (op.op === 'upsert') await syncRepo.upsertLink(ctx, userId, plan.id, op.link);
            else await syncRepo.deleteLink(ctx, userId, plan.id, op.key);
          }
        });
      }
    }
    if (failure !== null) throw failure;
  }

  async function insertBlock(
    env: WriteEnv,
    planId: string,
    d: DesiredBlock,
    timeZone: string,
  ): Promise<LinkRow | null> {
    for (let generation = 1; generation <= MAX_INSERT_GENERATIONS; generation += 1) {
      const id = eventIdFor(`${planId}:${d.key}:${generation}`);
      let event: CalendarEvent;
      try {
        event = await env.guard.insertAppEvent(env.appCalendarId, d.taskId, {
          id,
          summary: d.summary,
          colorId: d.colorId,
          start: timeOf(d.start, timeZone),
          end: timeOf(d.end, timeZone),
        });
      } catch (error) {
        // The id is held by something that is not ours to reuse: take the next generation.
        if (
          error instanceof CalendarWriteRefused &&
          (error.reason === 'event_id_taken' || error.reason === 'not_tagged_as_app_event') &&
          generation < MAX_INSERT_GENERATIONS
        ) {
          continue;
        }
        if (error instanceof CalendarWriteRefused) {
          log.warn({ reason: error.reason }, 'calendar event not created');
          return null;
        }
        throw error;
      }
      // A retried insert returns the event that is already there; it may sit at another time or
      // have another (or no) colour.
      if (
        instantOf(event.start) !== d.start.getTime() ||
        instantOf(event.end) !== d.end.getTime() ||
        event.colorId !== d.colorId
      ) {
        try {
          event = await env.guard.patchAppEvent(env.appCalendarId, id, {
            summary: d.summary,
            colorId: d.colorId,
            start: timeOf(d.start, timeZone),
            end: timeOf(d.end, timeZone),
          });
        } catch (error) {
          if (!(error instanceof CalendarWriteRefused)) throw error;
          log.warn({ reason: error.reason }, 'calendar event not changed');
          return null;
        }
      }
      return {
        block_key: d.key,
        task_id: d.taskId,
        event_id: id,
        generation,
        last_start: d.start,
        last_end: d.end,
        etag: event.etag ?? null,
        last_summary: d.summary,
        last_color: d.colorId,
      };
    }
    return null;
  }

  /** Null when the event could not be changed this time (it is retried by the next sync). */
  async function patchBlock(
    env: WriteEnv,
    link: LinkRow,
    d: DesiredBlock,
    timeZone: string,
  ): Promise<LinkRow | null> {
    try {
      const event = await env.guard.patchAppEvent(env.appCalendarId, link.event_id, {
        summary: d.summary,
        colorId: d.colorId,
        start: timeOf(d.start, timeZone),
        end: timeOf(d.end, timeZone),
      });
      return {
        ...link,
        last_start: d.start,
        last_end: d.end,
        etag: event.etag ?? null,
        last_summary: d.summary,
        last_color: d.colorId,
      };
    } catch (error) {
      if (error instanceof CalendarWriteRefused) {
        log.warn({ reason: error.reason }, 'calendar event not changed');
        return null;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------------- one run

  /** What the last sync did to the schedule, from stored data only (Google is not called). */
  async function impact(userId: string): Promise<Omit<SyncResult, 'status' | 'syncedAt'>> {
    const plans = await db.withUser(userId, (ctx) =>
      syncRepo.activePlans(ctx, userId, MAX_ACTIVE_PLANS),
    );
    const moved = new Set<string>();
    let finishChanged = false;
    const texts: string[] = [];
    for (const plan of plans) {
      try {
        const summary = await scheduling.calendarImpact(userId, plan.id);
        for (const id of summary.movedTaskIds) moved.add(id);
        finishChanged ||= summary.finishChanged;
        texts.push(summary.text);
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
      }
    }
    return {
      movedTaskIds: [...moved].sort(),
      finishChanged,
      text: texts.length > 0 ? texts.join(' ') : 'No active plan to schedule.',
    };
  }

  /**
   * One run for one user. `reads` false (after a saved reschedule) only does the write side,
   * unless the plan's time zone changed, which needs the busy rows rebuilt.
   */
  async function runSync(userId: string, reads: boolean): Promise<boolean> {
    try {
      const conn = await db.withUser(userId, async (ctx) => {
        const { rows } = await ctx.client.query<{
          status: string;
          app_calendar_id: string | null;
          refresh_token_ciphertext: string | null;
          sync_timezone: string | null;
        }>(
          `select status, app_calendar_id, refresh_token_ciphertext, sync_timezone
           from ${ctx.schema}.calendar_connections where user_id = $1`,
          [userId],
        );
        return rows[0] ?? null;
      });
      if (!conn || conn.status === 'disconnected' || !conn.refresh_token_ciphertext) {
        throw new HttpError(409, 'calendar_not_connected', 'Google Calendar is not connected.');
      }
      if (conn.status === 'needs_reconnect') throw reconnectRequired();

      const plans = await db.withUser(userId, (ctx) =>
        syncRepo.activePlans(ctx, userId, MAX_ACTIVE_PLANS),
      );
      const refreshToken = crypto.decrypt(conn.refresh_token_ciphertext, userId);
      const provider = options.providerFor(refreshToken);

      const primary = plans[0];
      let readDone = false;
      // The two halves are independent: a failed busy read does not stop the write side and the
      // other way round. The first failure is reported after both have been tried.
      let failure: unknown = null;
      if (primary) {
        const timeZone = primary.timezone;
        const today = localDateOf(now(), timeZone);
        if (reads || (conn.sync_timezone !== null && conn.sync_timezone !== timeZone)) {
          try {
            await readSide(userId, provider, conn.app_calendar_id, plans, timeZone, today);
            readDone = true;
          } catch (error) {
            failure = error;
          }
        }
        if (conn.app_calendar_id) {
          const env: WriteEnv = {
            userId,
            provider,
            guard: createWriteGuard(provider, conn.app_calendar_id),
            appCalendarId: conn.app_calendar_id,
          };
          try {
            for (const plan of plans) await syncPlan(env, plan);
          } catch (error) {
            failure ??= error;
          }
        }
      } else {
        readDone = reads;
      }
      if (failure !== null) throw failure;
      await db.withUser(userId, (ctx) => syncRepo.markSynced(ctx, userId, now(), readDone));
      return readDone;
    } catch (error) {
      throw await toHttpError(userId, error);
    }
  }

  // ---------------------------------------------------------------------------------- entry points

  return {
    /**
     * "Sync now" and app open. Within five minutes of the last sync the stored result is
     * returned without calling Google; `force` skips that, but not within a minute of the last
     * sync. A second sync for the same user while one runs answers 409 `sync_in_progress`.
     *
     * The lock is in memory (one API process on the free plan). With several instances two syncs
     * could overlap; the writes are idempotent (deterministic event ids, upserted links), so the
     * worst case is duplicate Google calls, not duplicate events. Needs a database lock if the
     * API is ever scaled out.
     */
    async syncNow(userId: string, opts: { force?: boolean } = {}): Promise<SyncResult> {
      const conn = await db.withUser(userId, async (ctx) => {
        const { rows } = await ctx.client.query<{ status: string; last_synced_at: Date | null }>(
          `select status, last_synced_at from ${ctx.schema}.calendar_connections where user_id = $1`,
          [userId],
        );
        return rows[0] ?? null;
      });
      if (!conn || conn.status === 'disconnected') {
        throw new HttpError(409, 'calendar_not_connected', 'Google Calendar is not connected.');
      }
      if (conn.status === 'needs_reconnect') throw reconnectRequired();

      const age = conn.last_synced_at ? now().getTime() - conn.last_synced_at.getTime() : Infinity;
      const fresh = opts.force === true ? age < FORCE_MIN_INTERVAL_MS : age < SYNC_THROTTLE_MS;
      if (fresh) {
        return {
          status: 'cached',
          syncedAt: conn.last_synced_at?.toISOString() ?? null,
          ...(await impact(userId)),
        };
      }
      if (running.has(userId)) {
        throw new HttpError(409, 'sync_in_progress', 'A calendar sync is already running.');
      }
      const state: Running = { rerun: false };
      running.set(userId, state);
      try {
        await runSync(userId, true);
        // A reschedule saved while this sync ran asked for another pass (write side only).
        for (let extra = 0; state.rerun && extra < MAX_EXTRA_PASSES; extra += 1) {
          state.rerun = false;
          await runSync(userId, false);
        }
      } finally {
        running.delete(userId);
      }
      const after = await db.withUser(userId, async (ctx) => {
        const { rows } = await ctx.client.query<{ last_synced_at: Date | null }>(
          `select last_synced_at from ${ctx.schema}.calendar_connections where user_id = $1`,
          [userId],
        );
        return rows[0]?.last_synced_at ?? null;
      });
      return {
        status: 'synced',
        syncedAt: after?.toISOString() ?? null,
        ...(await impact(userId)),
      };
    },

    /**
     * After a saved reschedule (the change is committed already). Best effort: starts the write
     * side in the background, never throws and never delays the caller. If a sync is running for
     * the user, one more run follows it, so the newest plan is the one that ends up in Google.
     */
    afterReschedule(userId: string): void {
      const existing = running.get(userId);
      if (existing) {
        existing.rerun = true;
        return;
      }
      const state: Running = { rerun: false };
      running.set(userId, state);
      const run = (async () => {
        try {
          do {
            state.rerun = false;
            try {
              await runSync(userId, false);
            } catch (error) {
              // Already reduced to a client error with no event data; log the code only.
              const code = error instanceof HttpError ? error.code : failureCode(error);
              // Not connected / needs reconnect is the normal state for most users: stay quiet.
              if (code !== 'calendar_not_connected' && code !== 'calendar_reconnect_required') {
                log.warn({ code }, 'calendar sync after reschedule did not finish');
              }
            }
          } while (state.rerun);
        } finally {
          running.delete(userId);
        }
      })();
      background.add(run);
      void run.finally(() => background.delete(run));
    },

    /** Resolves when no background run started by `afterReschedule` is left. Never rejects. */
    async idle(): Promise<void> {
      while (background.size > 0) await Promise.allSettled([...background]);
    },

    /**
     * Before a plan is deleted: removes its events from the app calendar (through the guard).
     * Best effort: any failure is logged by code and never blocks the deletion.
     */
    async deletePlanEvents(userId: string, planId: string): Promise<void> {
      try {
        const loaded = await db.withUser(userId, async (ctx) => {
          const { rows } = await ctx.client.query<{
            status: string;
            app_calendar_id: string | null;
            refresh_token_ciphertext: string | null;
          }>(
            `select status, app_calendar_id, refresh_token_ciphertext
             from ${ctx.schema}.calendar_connections where user_id = $1`,
            [userId],
          );
          const conn = rows[0];
          if (!conn || conn.status !== 'connected') return null;
          if (!conn.app_calendar_id || !conn.refresh_token_ciphertext) return null;
          return { conn, links: await syncRepo.links(ctx, userId, planId) };
        });
        if (!loaded || loaded.links.length === 0) return;
        const guard = createWriteGuard(
          options.providerFor(crypto.decrypt(loaded.conn.refresh_token_ciphertext!, userId)),
          loaded.conn.app_calendar_id!,
        );
        for (const link of loaded.links) {
          await guard.deleteAppEvent(loaded.conn.app_calendar_id!, link.event_id);
        }
      } catch (error) {
        log.warn(
          { reason: failureCode(error) },
          'calendar events of a deleted plan were not removed',
        );
      }
    },
  };
}

export type CalendarSync = ReturnType<typeof createCalendarSync>;
