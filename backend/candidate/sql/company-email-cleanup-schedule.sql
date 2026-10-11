-- Bounded cleanup for expired, unfinished company email OAuth staging only.
-- No provider HTTP requests, grant changes, mailbox reads or message sends.
-- Installation is a separately authorized production change.
DO $schedule$
DECLARE
  existing record;
  matching_jobs integer;
  expected_command constant text := 'SET statement_timeout = ''30s''; SET lock_timeout = ''2s''; SELECT public.cleanup_expired_company_email_oauth_setups(100);';
BEGIN
  SELECT count(*) INTO matching_jobs FROM cron.job WHERE jobname = 'kairo-company-email-oauth-cleanup';
  IF matching_jobs > 1 THEN RAISE EXCEPTION 'Duplicate company email cleanup schedules'; END IF;
  SELECT * INTO existing FROM cron.job WHERE jobname = 'kairo-company-email-oauth-cleanup';
  IF FOUND THEN
    IF existing.schedule <> '*/5 * * * *' OR existing.command <> expected_command OR NOT existing.active
      OR existing.database <> current_database() OR existing.username <> current_user
      OR existing.nodename <> 'localhost' OR existing.nodeport <> current_setting('port')::integer THEN
      RAISE EXCEPTION 'Unexpected existing company email cleanup schedule';
    END IF;
  ELSE
    PERFORM cron.schedule('kairo-company-email-oauth-cleanup', '*/5 * * * *', expected_command);
    SELECT * INTO STRICT existing FROM cron.job WHERE jobname = 'kairo-company-email-oauth-cleanup';
    IF existing.database <> current_database() OR existing.username <> current_user
      OR existing.nodename <> 'localhost' OR existing.nodeport <> current_setting('port')::integer THEN
      RAISE EXCEPTION 'Unexpected company email cleanup target';
    END IF;
  END IF;
END
$schedule$;
