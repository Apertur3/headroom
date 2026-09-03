# docs/ — in-repo operational runbooks

Keep operational runbooks **in the repo** so the agent (and future-you) can act
without reconstructing tribal knowledge. Lesson from the gbrain Postgres
migration (2026-06-14): the painful part was the *undocumented* "how do I stand
up the DB / migrate / repoint" steps.

Add docs as the project earns them — don't pre-write 30. Typical ones:

- `db-setup.md` — how to provision the database/services from scratch.
- `migrate.md` — how to run/roll back migrations; gotchas (e.g. RLS needs a
  SUPERUSER/BYPASSRLS role; event triggers are superuser-only).
- `deploy.md` — how a release actually ships (host, command, cache-bust gates).
- `runbook.md` — recovery steps for known failure modes.

Architecture *decisions* and *why* go in the vault (`decisions/log.md`), not
here. This dir is for repeatable mechanical procedures.
