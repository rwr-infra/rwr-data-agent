# skills.d

Markdown playbooks appended to the system prompt when a question matches their triggers. Drop a
file in and it is picked up on the next request — as long as `TOOLS_HOT_RELOAD` is on, which it is
by default outside production. With it off, a change needs a restart. See the Skills section in
`AGENTS.md`.

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

## Three rules worth knowing before writing one

**Triggers are mandatory.** Unlike a plugin tool — where declaring `triggers` is opting *in* to
being hidden — a skill with no triggers is a configuration error, recorded on `GET /v1/tools` and
skipped. Hiding a tool costs the model an option it can ask for on a later step; prose has no such
recovery, so an always-on skill is paid for in every turn's context whether or not it is relevant.
A list of blank triggers is rejected the same way: a skill that loads but can never fire is worse
than one that refuses to load, because nothing tells you.

**Keep the body under 16 000 characters** (~4K tokens). Over that the file is rejected outright,
not truncated — it would otherwise land in the system prompt of every matching turn and push the
request past the prompt-size guard, which answers 400 and blames the prompt rather than this file.
If a playbook is genuinely that long, it is several skills with tighter triggers.

**Do not restate the built-in prompt.** `SYSTEM_PROMPT` (`src/retrieval/prompt.ts`) already carries
playbooks for inheritance, reverse lookups and AngelScript, plus the traceability and absence rules.
A skill that repeats them is not free: it costs tokens on every matching turn, and duplicated
instructions measurably pushed one eval case from 5 steps to 7. Write skills for what the base
prompt does *not* know — a specific mod's quirks, a local naming convention, a house output format.
