import { randomBytes } from 'node:crypto';
import { environmentNames, migrate, setPasswords } from '@skillstack/db';
import pg from 'pg';

/**
 * Throwaway database for the e2e run: the `rnd` schema is dropped, migrated with the real
 * migrations and given random passwords. TEST INFRASTRUCTURE: it refuses anything that is not a
 * loopback database, because it DROPS the schema first.
 */
const SCHEMA = 'rnd' as const;

function assertLoopback(name: string, connectionString: string): void {
  const host = new URL(connectionString).hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
    throw new Error(`${name} must point at a local throwaway database (got host "${host}").`);
  }
}

export async function withClient<T>(url: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function withLogin(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

/**
 * The API's clock is fixed (E2E_NOW, Monday 2026-11-02) but `plans.created_at` comes from the
 * database's real clock, and a plan's first day is never before the day it was created in. So
 * once the real date passed 2026-11-01 (Jerusalem) the demo plan's Sunday was "before the plan
 * began", and a real date after 2026-11-02 would put the plan's first day in the future. This
 * throwaway database therefore stamps every new plan as created on Sunday, the demo plan's start.
 */
async function pinPlanCreationDay(superuserUrl: string): Promise<void> {
  await withClient(superuserUrl, async (client) => {
    await client.query(
      `create function ${SCHEMA}.e2e_pin_plan_created_at() returns trigger language plpgsql as
       $$ begin new.created_at := timestamptz '2026-11-01 08:00:00+00'; return new; end $$`,
    );
    await client.query(
      `create trigger e2e_pin_plan_created_at before insert on ${SCHEMA}.plans
       for each row execute function ${SCHEMA}.e2e_pin_plan_created_at()`,
    );
  });
}

/** Returns the DATABASE_URL of the API (the app_rnd login with a fresh random password). */
export async function prepareDatabase(adminUrl: string, superuserUrl: string): Promise<string> {
  assertLoopback('TEST_DATABASE_URL', adminUrl);
  assertLoopback('TEST_SUPERUSER_URL', superuserUrl);
  const names = environmentNames(SCHEMA);
  const roles = [names.app, names.appUser, names.backup, names.owner];

  await withClient(superuserUrl, async (client) => {
    await client.query(`drop schema if exists ${SCHEMA} cascade`);
    for (const role of roles) {
      const { rows } = await client.query('select from pg_roles where rolname = $1', [role]);
      if (rows.length > 0) await client.query(`drop owned by ${role}`);
    }
    for (const role of roles) {
      const { rows } = await client.query('select from pg_roles where rolname = $1', [role]);
      if (rows.length > 0) await client.query(`drop role ${role}`);
    }
  });

  await migrate({ schema: SCHEMA, connectionString: adminUrl });
  await pinPlanCreationDay(superuserUrl);
  // Generated now, held in memory and in the API's environment only. Never written to disk.
  const appPassword = randomBytes(18).toString('hex');
  await setPasswords({
    schema: SCHEMA,
    connectionString: adminUrl,
    appPassword,
    backupPassword: randomBytes(18).toString('hex'),
  });
  return withLogin(adminUrl, names.app, appPassword);
}

/** Puts the email on the sign-in allowlist (what promote-admin does for a new person). */
export async function allowEmail(superuserUrl: string, email: string): Promise<void> {
  await withClient(superuserUrl, (client) =>
    client.query(
      `insert into ${SCHEMA}.allowed_emails (email, added_by) values ($1, 'e2e') on conflict do nothing`,
      [email.toLowerCase()],
    ),
  );
}
