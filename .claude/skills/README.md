# Project skills

Claude loads these automatically when working in this repo.

| Skill | Use it for |
|---|---|
| `ui-ux-pro-max` | Design direction, palettes, font pairings, UX/accessibility rules and Astro-specific guidance. Search: `python .claude/skills/ui-ux-pro-max/scripts/search.py "<query>" --stack astro` (run from the repo root). |
| `design-system` | Turning the site's CSS variables into a proper token system, and checking for hardcoded values: `node .claude/skills/design-system/scripts/validate-tokens.cjs --dir site/src --ignore email` |

Source: [nextlevelbuilder/ui-ux-pro-max-skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) v2.15.0 (commit 28b3b8d), MIT licence (`LICENSE-ui-ux-pro-max`). The other skills in that repo (brand, banner-design, slides, ui-styling, design) were left out: the site doesn't use Tailwind/shadcn, and logos, banners and decks aren't current work.

Local changes from upstream:

- `ui-ux-pro-max/SKILL.md`: script paths used `${CLAUDE_PLUGIN_ROOT}`, which is only set for plugin installs. As a project skill it was empty and every search pointed at `/.claude/...`. Paths are now repo-relative.
- `ui-ux-pro-max/scripts/tests`: removed four tests for upstream release tooling that isn't shipped with the skill. They crashed test collection with `StopIteration`.
- `design-system/scripts/validate-tokens.cjs`: now scans `.astro` files (all our component styles live there). It no longer flags token definitions (`--grass: #c8902f`), breakpoints in `@media`/`@container` or `<img sizes>`, or lines inside `/** */` comments. Regression tests were added for each.

Email templates (`site/src/lib/email`) are skipped with `--ignore email` because email clients need inline colours.
