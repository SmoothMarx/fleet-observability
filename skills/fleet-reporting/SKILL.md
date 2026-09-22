---
name: fleet-reporting
description: Use when work must show up on the fleet status page.
---

# Reporting to the fleet

A fleet page can see that a session exists, how long it has been alive, and whether it
died. It cannot see **what the work is doing, how far along it is, or when it will be
done** — nothing on the box records that. So the page has exactly one authored input,
and this skill is how you write to it.

## The one rule

**You are the only source of "what am I doing".** If you do not report, your row says
*nothing reported*, which is honest and useless. Report at the start, at each real phase
change, when you get blocked, and once at the end.

## The tool

```
python3 ~/.hermes/scripts/fleet_evt.py start <id> --label "…" [--doing "…"] [--eta 15] [--total 100 --unit files] [--owner "…"] [--project "…"]
python3 ~/.hermes/scripts/fleet_evt.py phase <id> --doing "now doing X" [--done 40] [--eta 12]
python3 ~/.hermes/scripts/fleet_evt.py note  <id> --doing "blocked on the approval prompt"
python3 ~/.hermes/scripts/fleet_evt.py end   <id> --outcome done|failed|abandoned [--doing "final words"]
```

It appends one JSON line per call to `~/.hermes/fleet/events.jsonl` (rotated above 2 MB;
the collector only needs 48 h). The collector folds that file into the page's rows. The
same script ships with the desktop plug-in at `skills/fleet-reporting/scripts/fleet_evt.py`.

`<id>` is a slug you will recognise later (`voice-f5tts-build`, `sub:ab12cd`). Every event
with the same id folds into ONE row, newest value per field wins.

**`start` is the clock.** It fixes the timestamp *Elapsed* counts from and the `--eta`
that *ETA guess* is compared against, so an optimistic guess shows up as honest drift
instead of hiding.

| field | what the reader sees |
|---|---|
| `--label` | the row name |
| `--doing` | *Doing* — one present-tense phrase, no log lines |
| `--done/--total/--unit` | *Progress* and its bar |
| `--eta` | *ETA guess* in minutes; with no progress the page labels it `guess-only` |
| `--owner` / `--project` | which group the row sorts into |
| `--outcome` (on `end`) | done / failed / abandoned |
| `--kind` | which section: `subagent` for delegated work, `session` for a whole chat. Set it on `start` and it sticks; omit it anywhere and the row is filed as a subagent. |

## Rules

- **Report at phase changes, not per step.** A `phase` for every file you touch turns the page into a log nobody reads.
- **Only send numbers you measured.** `--done 40 --total 100 --unit files` means you counted them.
- **Append-only, never rewrite.** To correct a row, append another event; the newest value for a field wins.
- **Always `end`.** A row that never ends keeps claiming to be working, then goes stale-amber and accuses you — correctly. Finish it with `--outcome`.
- **Nothing may follow `end` for that id:** a later event re-opens the row as live. Use a new id if the work restarts.
- Report the id your parent gave you, so the parent's row and the page agree.

## Check yourself

```
python3 ~/.hermes/scripts/fleet_status.py       # rebuilds the page + fleet-status.json
grep your-id ~/.hermes/fleet/events.jsonl
```

Your row should carry your `doing`; after `end --outcome done` it reads *done* and ages off
the page within a day.

## Pitfalls

- **A typo in `<id>` creates a second row** instead of updating the first. Copy-paste the id.
- **`end` without `--outcome`** ends the row but leaves it unlabelled; pass the outcome explicitly.
- **Stale by silence:** if nothing new arrives for 10 minutes while you claim to be working, the row is switched to *stale*. That is the page being honest, not a bug — send a `phase`/`note` through a long quiet stretch.
- **A later event cannot re-file a row by accident:** the writer sends only the fields you pass, so a `phase` with no `--kind` leaves the kind alone (an earlier version defaulted it on every append and quietly turned a `session` row into a `subagent` one).
- **This file is a status surface, not a log.** Anything worth keeping belongs in the work's own docs.
