# Gentle Giant

A browser game about a giant who loves a tiny valley, and slowly learns what the villagers really think of it.

**Play:** https://ostromaj.github.io/gentle-giant/

Walk the valley as Oru or Vela, decode the villagers' glyph language and secret script, water their fields or smite them, shape the land, take on Aspects, and reach one of seven endings. Every night the villagers meet in secret and plan what to do about you. On this site their council is run by Claude.

## How it fits together

- `index.html` is the whole game: three.js, no build step. GitHub Pages serves it.
- `server/` is a tiny Node server (no dependencies) that runs the villagers' nightly council. It holds the Anthropic API key, builds the prompt itself from game data, asks Claude Haiku 5.5 for plans, checks every plan against what the game can do, and sends them back.
- If the server is asleep, over budget or unreachable, the village plans on its own instincts instead, so the game always works.

## Server settings (Render environment variables)

| Variable | What it does | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Your Claude API key. Set it in Render, never in the code. | none |
| `DAILY_CAP_USD` | Stop calling Claude after this much spend in a UTC day. | `1` |
| `MODEL` | Which Claude model plans the council. | `claude-haiku-5-5` |
| `ALLOWED_ORIGINS` | Sites allowed to call the server. | `https://ostromaj.github.io` |
| `PER_PLAYER_PER_HOUR` / `PER_IP_PER_HOUR` | Rate limits. | `20` / `40` |

The daily spend counter lives in memory, so it resets if the server restarts. Set a monthly spend limit in the Claude Console as a backstop.
