# skills.d

Markdown playbooks appended to the system prompt when a question matches their triggers. Drop a
file in, no restart needed (outside production). See the Skills section in `AGENTS.md`.

Files beginning with `_` or `.` are skipped, which is why this one is not loaded as a skill.

## Format

```markdown
---
name: castling-upgrade-chains
triggers: [升级, upgrade, mod3]
---
Resolve the base weapon before walking the upgrade chain: Castling names the tiers after the
base, so `lookupUpgrade` on a tier key returns nothing useful.
```

`triggers` accepts an inline `[a, b]` list or `-` lines. Matching is case-insensitive substring,
so CJK works without a segmenter.

## Two rules worth knowing before writing one

**Triggers are mandatory.** Unlike a plugin tool — where declaring `triggers` is opting *in* to
being hidden — a skill with no triggers is a configuration error, recorded on `GET /v1/tools` and
skipped. Hiding a tool costs the model an option it can ask for on a later step; prose has no such
recovery, so an always-on skill is paid for in every turn's context whether or not it is relevant.

**Do not restate the built-in prompt.** `SYSTEM_PROMPT` (`src/retrieval/prompt.ts`) already carries
playbooks for inheritance, reverse lookups and AngelScript, plus the traceability and absence rules.
A skill that repeats them is not free: it costs tokens on every matching turn, and duplicated
instructions measurably pushed one eval case from 5 steps to 7. Write skills for what the base
prompt does *not* know — a specific mod's quirks, a local naming convention, a house output format.
