import type { UserContext } from '../../db/database';

/**
 * SQL for the calendar sync engine. Every function runs inside `db.withUser` (row-level security
 * limits it to the signed-in user); the explicit `user_id = $1` is a second line of defence and
 * the id always comes from the verified token. Nothing here stores an event description,
 * attendee or location.
 */

export interface SyncSource {
  calendar_id: string;
  blocks_time: boolean;
  sync_token: string | null;
  window_start: string | null;
  window_end: string | null;
}

export interface ActivePlan {
  id: string;
  end_date: string | null;
  timezone: string;
}

export interface LinkRow {
  block_key: string;
  task_id: string;
  event_id: string;
  generation: number;
  last_start: Date;
  last_end: Date;
  etag: string | null;
  last_summary: string | null;
}

export interface LockedRow {
  block_key: string;
  task_id: string;
  starts_at: Date;
  ends_at: Date;
  reason: 'moved' | 'deleted';
}

export interface BusyInsert {
  date: string;
  externalEventId: string;
  startMinute: number;
  endMinute: number;
  title: string;
  kind: 'busy' | 'tentative' | 'all_day';
  blocksDay: boolean;
}

const INSERT_CHUNK = 500;

export const syncRepo = {
  async sources(ctx: UserContext, userId: string): Promise<SyncSource[]> {
    const { rows } = await ctx.client.query<SyncSource>(
      `select calendar_id, blocks_time, sync_token, window_start::text as window_start,
              window_end::text as window_end
       from ${ctx.schema}.calendar_sources where user_id = $1 order by calendar_id`,
      [userId],
    );
    return rows;
  },

  async syncTimezone(ctx: UserContext, userId: string): Promise<string | null> {
    const { rows } = await ctx.client.query<{ sync_timezone: string | null }>(
      `select sync_timezone from ${ctx.schema}.calendar_connections where user_id = $1`,
      [userId],
    );
    return rows[0]?.sync_timezone ?? null;
  },

  /** The user's active plans that have a week pattern, most recently changed first. */
  async activePlans(ctx: UserContext, userId: string, limit: number): Promise<ActivePlan[]> {
    const { rows } = await ctx.client.query<ActivePlan>(
      `select p.id, p.end_date::text as end_date, w.timezone
       from ${ctx.schema}.plans p
       join ${ctx.schema}.week_patterns w on w.user_id = p.user_id and w.plan_id = p.id
       where p.user_id = $1 and p.status = 'active'
       order by p.updated_at desc, p.id limit $2`,
      [userId, limit],
    );
    return rows;
  },

  async clearAllBusy(ctx: UserContext, userId: string): Promise<void> {
    await ctx.client.query(`delete from ${ctx.schema}.calendar_busy where user_id = $1`, [userId]);
    await ctx.client.query(
      `update ${ctx.schema}.calendar_sources
       set sync_token = null, window_start = null, window_end = null where user_id = $1`,
      [userId],
    );
  },

  /** Sources that do not block time: their rows and tokens go. One statement for any number. */
  async dropSources(ctx: UserContext, userId: string, calendarIds: string[]): Promise<void> {
    if (calendarIds.length === 0) return;
    await ctx.client.query(
      `delete from ${ctx.schema}.calendar_busy
       where user_id = $1 and source_calendar_id = any($2::text[])`,
      [userId, calendarIds],
    );
    await ctx.client.query(
      `update ${ctx.schema}.calendar_sources
       set sync_token = null, window_start = null, window_end = null
       where user_id = $1 and calendar_id = any($2::text[])
         and (sync_token is not null or window_start is not null or window_end is not null)`,
      [userId, calendarIds],
    );
  },

  /** Ids of all-day events the user marked as blocking (rows with blocks_day) in one source. */
  async blockingIds(ctx: UserContext, userId: string, calendarId: string): Promise<Set<string>> {
    const { rows } = await ctx.client.query<{ external_event_id: string }>(
      `select distinct external_event_id from ${ctx.schema}.calendar_busy
       where user_id = $1 and source_calendar_id = $2 and blocks_day`,
      [userId, calendarId],
    );
    return new Set(rows.map((r) => r.external_event_id));
  },

  /**
   * Stores one source's listing. `replaceAll` (a full listing) swaps all of the source's rows;
   * otherwise only the rows of `touchedIds` (the events the incremental listing mentioned) are
   * replaced. Rows before `keepFrom` are pruned for every source. Then the token is stored.
   */
  async applySource(
    ctx: UserContext,
    userId: string,
    calendarId: string,
    values: {
      replaceAll: boolean;
      touchedIds: string[];
      rows: BusyInsert[];
      keepFrom: string;
      syncToken: string | null;
      /** Null keeps the stored window (an incremental listing does not change it). */
      window: { start: string; end: string } | null;
    },
  ): Promise<void> {
    const t = ctx.schema;
    if (values.replaceAll) {
      await ctx.client.query(
        `delete from ${t}.calendar_busy where user_id = $1 and source_calendar_id = $2`,
        [userId, calendarId],
      );
    } else if (values.touchedIds.length > 0) {
      await ctx.client.query(
        `delete from ${t}.calendar_busy
         where user_id = $1 and source_calendar_id = $2 and external_event_id = any($3::text[])`,
        [userId, calendarId, values.touchedIds],
      );
    }
    await ctx.client.query(
      `delete from ${t}.calendar_busy where user_id = $1 and date < $2::date`,
      [userId, values.keepFrom],
    );
    for (let i = 0; i < values.rows.length; i += INSERT_CHUNK) {
      const chunk = values.rows.slice(i, i + INSERT_CHUNK);
      // One row per (event, date); the same event listed by two calendars is stored once.
      await ctx.client.query(
        `insert into ${t}.calendar_busy
           (user_id, date, external_event_id, source_calendar_id, start_minute, end_minute, title,
            kind, blocks_day)
         select $1::uuid, d, e, $2::text, s, n, ti, k, b
         from unnest($3::date[], $4::text[], $5::int[], $6::int[], $7::text[], $8::text[], $9::bool[])
           as x(d, e, s, n, ti, k, b)
         on conflict (user_id, external_event_id, date) do nothing`,
        [
          userId,
          calendarId,
          chunk.map((r) => r.date),
          chunk.map((r) => r.externalEventId),
          chunk.map((r) => r.startMinute),
          chunk.map((r) => r.endMinute),
          chunk.map((r) => r.title),
          chunk.map((r) => r.kind),
          chunk.map((r) => r.blocksDay),
        ],
      );
    }
    await ctx.client.query(
      `update ${t}.calendar_sources
       set sync_token = $3,
           window_start = coalesce($4::date, window_start),
           window_end = coalesce($5::date, window_end)
       where user_id = $1 and calendar_id = $2`,
      [
        userId,
        calendarId,
        values.syncToken,
        values.window?.start ?? null,
        values.window?.end ?? null,
      ],
    );
  },

  async setSyncTimezone(ctx: UserContext, userId: string, timezone: string): Promise<void> {
    await ctx.client.query(
      `update ${ctx.schema}.calendar_connections set sync_timezone = $2 where user_id = $1`,
      [userId, timezone],
    );
  },

  async markSynced(ctx: UserContext, userId: string, at: Date, readDone: boolean): Promise<void> {
    await ctx.client.query(
      `update ${ctx.schema}.calendar_connections
       set last_synced_at = case when $3 then $2 else last_synced_at end,
           last_error_code = null, updated_at = now()
       where user_id = $1 and status = 'connected'`,
      [userId, at, readDone],
    );
  },

  async setLastError(ctx: UserContext, userId: string, code: string): Promise<void> {
    await ctx.client.query(
      `update ${ctx.schema}.calendar_connections set last_error_code = $2, updated_at = now()
       where user_id = $1`,
      [userId, code],
    );
  },

  /** Titles are read only to be written to the user's own app calendar; they are never logged. */
  async openTasks(
    ctx: UserContext,
    userId: string,
    planId: string,
  ): Promise<Map<string, { title: string; open: boolean }>> {
    const { rows } = await ctx.client.query<{ id: string; title: string; status: string }>(
      `select id, title, status from ${ctx.schema}.tasks where user_id = $1 and plan_id = $2`,
      [userId, planId],
    );
    return new Map(
      rows.map((r) => [
        r.id,
        { title: r.title, open: r.status === 'pending' || r.status === 'in_progress' },
      ]),
    );
  },

  async links(ctx: UserContext, userId: string, planId: string): Promise<LinkRow[]> {
    const { rows } = await ctx.client.query<LinkRow>(
      `select block_key, task_id, event_id, generation, last_start, last_end, etag, last_summary
       from ${ctx.schema}.calendar_event_links where user_id = $1 and plan_id = $2
       order by block_key`,
      [userId, planId],
    );
    return rows;
  },

  async upsertLink(ctx: UserContext, userId: string, planId: string, link: LinkRow): Promise<void> {
    await ctx.client.query(
      `insert into ${ctx.schema}.calendar_event_links
         (user_id, plan_id, block_key, task_id, event_id, generation, last_start, last_end, etag,
          last_summary)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (user_id, plan_id, block_key) do update set
         task_id = excluded.task_id, event_id = excluded.event_id, generation = excluded.generation,
         last_start = excluded.last_start, last_end = excluded.last_end, etag = excluded.etag,
         last_summary = excluded.last_summary, updated_at = now()`,
      [
        userId,
        planId,
        link.block_key,
        link.task_id,
        link.event_id,
        link.generation,
        link.last_start,
        link.last_end,
        link.etag,
        link.last_summary,
      ],
    );
  },

  async deleteLink(
    ctx: UserContext,
    userId: string,
    planId: string,
    blockKey: string,
  ): Promise<void> {
    await ctx.client.query(
      `delete from ${ctx.schema}.calendar_event_links
       where user_id = $1 and plan_id = $2 and block_key = $3`,
      [userId, planId, blockKey],
    );
  },

  async locked(ctx: UserContext, userId: string, planId: string): Promise<LockedRow[]> {
    const { rows } = await ctx.client.query<LockedRow>(
      `select block_key, task_id, starts_at, ends_at, reason
       from ${ctx.schema}.calendar_locked_blocks where user_id = $1 and plan_id = $2
       order by block_key`,
      [userId, planId],
    );
    return rows;
  },

  async upsertLocked(
    ctx: UserContext,
    userId: string,
    planId: string,
    row: LockedRow,
  ): Promise<void> {
    await ctx.client.query(
      `insert into ${ctx.schema}.calendar_locked_blocks
         (user_id, plan_id, block_key, task_id, starts_at, ends_at, reason)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (user_id, plan_id, block_key) do update set
         task_id = excluded.task_id, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         reason = excluded.reason`,
      [userId, planId, row.block_key, row.task_id, row.starts_at, row.ends_at, row.reason],
    );
  },

  async deleteLocked(
    ctx: UserContext,
    userId: string,
    planId: string,
    blockKey: string,
  ): Promise<void> {
    await ctx.client.query(
      `delete from ${ctx.schema}.calendar_locked_blocks
       where user_id = $1 and plan_id = $2 and block_key = $3`,
      [userId, planId, blockKey],
    );
  },

  async deleteLockedMany(
    ctx: UserContext,
    userId: string,
    planId: string,
    blockKeys: string[],
  ): Promise<void> {
    if (blockKeys.length === 0) return;
    await ctx.client.query(
      `delete from ${ctx.schema}.calendar_locked_blocks
       where user_id = $1 and plan_id = $2 and block_key = any($3::text[])`,
      [userId, planId, blockKeys],
    );
  },
};
