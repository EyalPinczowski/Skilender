import { createClient } from './connection';
import { environmentNames, parseEnvironment } from './names';

export const MIN_PASSWORD_LENGTH = 24;

export interface SetPasswordsOptions {
  schema: string;
  connectionString: string;
  appPassword: string;
  backupPassword: string;
}

/** Sets the passwords of `app_<schema>` and `backup_<schema>`. Never returns or logs them. */
export async function setPasswords(options: SetPasswordsOptions): Promise<void> {
  const names = environmentNames(parseEnvironment(options.schema));
  for (const [label, value] of [
    ['APP_PASSWORD', options.appPassword],
    ['BACKUP_PASSWORD', options.backupPassword],
  ] as const) {
    if (value.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`${label} must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
    }
  }

  const client = createClient(options.connectionString);
  await client.connect();
  try {
    await client.query('begin');
    // The passwords travel as bind parameters into transaction-local settings. The ALTER ROLE
    // statements are then built and executed on the server with %I / %L quoting, so the
    // passwords are never spliced into SQL text on the client.
    await client.query(
      `select set_config('upversion.app_password', $1, true),
              set_config('upversion.backup_password', $2, true)`,
      [options.appPassword, options.backupPassword],
    );
    await client.query(
      `do $$
       begin
         execute format('alter role %I password %L', '${names.app}',
                        current_setting('upversion.app_password'));
         execute format('alter role %I password %L', '${names.backup}',
                        current_setting('upversion.backup_password'));
       end
       $$`,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}
