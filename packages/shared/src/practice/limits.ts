/**
 * Input limits of the practice routes. The API enforces them (it stays the authority); the web app
 * reads the same numbers only to stop typing past them and to word its hints.
 */
export const MAX_JOB_DESCRIPTION_LENGTH = 8000;
export const MAX_PASTED_FEEDBACK_LENGTH = 20_000;
/** The most hours one practice session can log. */
export const MAX_LOG_HOURS = 12;
