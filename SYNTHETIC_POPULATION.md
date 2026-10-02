# ARCANUM Synthetic Population v1

Private pre-launch population simulator for the multiplayer TCG.

## What it does

- provisions persistent synthetic accounts through the trusted server API
- uses the same pack purchasing and deck persistence API as normal accounts
- connects through Socket.IO like a real client
- creates and joins public lobby matches
- plays the authoritative PvP engine with human-scale decision delays
- has persistent personalities affecting aggression, skill, risk, patience, spending and chat frequency
- buys packs and rebuilds decks over time
- connects and disconnects according to a daily activity curve
- exposes private aggregate telemetry to the administrator

Synthetic accounts are marked internally in Postgres with `is_synthetic = true`. The flag is not included in the public profile payload.

## Safety switch

The population is **off by default**.

Enable only on the private pre-launch environment:

```
SYNTHETIC_POPULATION_ENABLED=true
```

## Configuration

```
SYNTHETIC_ACCOUNT_COUNT=200
SYNTHETIC_CONCURRENT_TARGET=40
SYNTHETIC_TIMEZONE_OFFSET_HOURS=2
SYNTHETIC_MIN_DECISION_MS=1600
SYNTHETIC_MAX_DECISION_MS=14000
SYNTHETIC_ADMIN_TOKEN=<long random secret>
```

The server also needs the existing:

```
ROLPLAY_SERVER_KEY=<existing trusted settlement key>
ROLPLAY_API_URL=<rolplay-api edge function URL>
```

Optional:

```
SYNTHETIC_SERVER_URL=http://127.0.0.1:<PORT>
```

Normally this should be omitted so agents connect back to the local multiplayer server.

## Admin telemetry

When `SYNTHETIC_ADMIN_TOKEN` is set:

```
GET /synthetic/state
x-synthetic-admin-token: <token>
```

Returns configured/online agents, active matches, pack purchases, decks built, decisions, chat activity and recent internal errors.

## Rollout

Do not jump directly to hundreds of concurrent sockets.

Recommended private QA ramp:

1. 10 concurrent for 15 minutes
2. 25 concurrent for 30 minutes
3. 50 concurrent for 30 minutes
4. 100 concurrent while watching Render CPU/RAM and Supabase latency
5. raise further only if error rate, latency and memory remain stable

`SYNTHETIC_ACCOUNT_COUNT` is the persistent population size. `SYNTHETIC_CONCURRENT_TARGET` is the maximum simultaneous target; the actual online count follows a human-like daily activity curve.

## Supabase deployment order

Before enabling the population:

1. apply `supabase/migrations/20261003003000_rolplay_synthetic_accounts.sql`
2. deploy `supabase/functions/rolplay-api/index.ts`
3. deploy the multiplayer server
4. set the synthetic environment variables
5. start with a low concurrent target and inspect telemetry

The trusted action `synthetic_provision` cannot be called by ordinary clients because it requires the same hashed `ROLPLAY_SERVER_KEY` validation used by match/trade settlement.
