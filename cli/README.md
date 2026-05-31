# @odyhook/cli — `ody`

Stream webhooks from your self-hosted Odyhook instance to your local machine.

## Install

```sh
npm i -g @odyhook/cli
```

## Authenticate

```sh
ody login
# Instance host URL (e.g. https://odyhook.dev): https://your-instance
# API token (ody_…): ody_…   ← mint at Settings → API Tokens
```

Credentials are stored in `~/.config/odyhook/config.json` (mode 600). For CI, set
`ODYHOOK_HOST` and `ODYHOOK_TOKEN` instead — env vars override the file.

## Listen

Forward live events from a source to a local URL:

```sh
ody listen --source gh-prod --forward http://localhost:3000/webhook
```

Replay recent history first, then go live:

```sh
ody listen --source gh-prod --forward http://localhost:3000/webhook --since 1h
```

Events are forwarded with their original method, headers (minus hop-by-hop), and raw body,
so your app's signature verification still works. The stream auto-reconnects and resumes
from the last event it saw.

## Trigger test events

```sh
# From a file or stdin
ody trigger gh-prod --data @payload.json --header "X-GitHub-Event: push"
cat payload.json | ody trigger gh-prod --data -

# Replay a stored event by id (creates a new event)
ody trigger gh-prod --replay evt_abc123
```
