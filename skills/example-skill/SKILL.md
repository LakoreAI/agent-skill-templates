---
name: example-skill
description: Example skill that shows the layout every skill in this repo follows. Use when the user asks for a demo of the skill template, or as a reference when writing a new skill.
---

# Example Skill

Replace this body with instructions the agent should follow once the skill triggers.

## When to use

- State the situations that should trigger this skill. The `description` in the
  frontmatter is what agents match against, so put the trigger words there too.

## Steps

1. Do the first thing.
2. Read `references/guide.md` only when you need the detail. Keep this file short.
3. Run `scripts/hello.sh <name>` for anything deterministic instead of re-deriving it.

## Rules

- Keep SKILL.md under 500 lines. Push detail into `references/`.
- Use relative paths for bundled files so the skill works from any install location.
