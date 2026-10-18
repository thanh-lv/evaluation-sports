# Developer entry points. `make test` runs every Linux-verifiable check (scripts/check.sh).
DENO_VERSION ?= 2.9.6
D := npx -y deno@$(DENO_VERSION)
CFG := --config supabase/functions/deno.json

.PHONY: test sql fmt schemas fixtures dev stop reset logs

test:
	bash scripts/check.sh

# SQL suite only (local Supabase stack via Docker). WARNING: runs `supabase db reset` unless SKIP_RESET=1.
sql:
	bash supabase/tests/sql/run.sh

fmt:
	$(D) fmt $(CFG) supabase/functions supabase/tests scripts

schemas:
	$(D) run -A $(CFG) scripts/gen-schemas.ts

fixtures:
	$(D) run -A $(CFG) scripts/gen-minimal-fixture.ts

dev stop reset logs:
	@echo "make $@: implemented in dev-stack milestone"
