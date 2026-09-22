#!/usr/bin/env python3
"""
fleet_evt.py — author the fields the box cannot observe.

Nothing records "what an in-chat sub-agent is doing", its progress, or its ETA.
Those are written here by the assistant when a child starts, when the phase
changes, and when it ends. Append-only JSONL; the collector folds it.

Usage:
  fleet_evt.py start <id> --label "..." [--eta 15] [--total 100 --unit files] \
                        [--doing "first step"] [--owner "parent session/skill"]
  fleet_evt.py phase <id> --doing "now doing X" [--done 40] [--eta 12]
  fleet_evt.py note  <id> --doing "blocked on approval prompt"
  fleet_evt.py end   <id> [--outcome done|failed|abandoned] [--doing "final words"]

Ids are free-form slugs, e.g. 'voice-f5tts-build' or 'sub:ab12cd'.
"""
import argparse
import json
import os
import sys
import time

# FLEET_DIR lets a test (or a different box) point the writer somewhere else; the
# collector reads ~/.hermes/fleet unless it is told otherwise.
FLEET_DIR = os.path.expanduser(os.environ.get("FLEET_DIR") or "~/.hermes/fleet")
EVENTS = os.path.join(FLEET_DIR, "events.jsonl")
MAX_BYTES = 2 * 1024 * 1024  # rotate above 2MB; the collector only needs 48h


def append(rec):
    os.makedirs(FLEET_DIR, exist_ok=True)
    if os.path.exists(EVENTS) and os.path.getsize(EVENTS) > MAX_BYTES:
        try:
            with open(EVENTS, "r", encoding="utf-8") as fh:
                lines = fh.readlines()[-2000:]
            tmp = EVENTS + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.writelines(lines)
            os.replace(tmp, EVENTS)
        except OSError:
            pass
    rec = {"ts": time.time(), **rec}
    with open(EVENTS, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec


def main():
    p = argparse.ArgumentParser()
    p.add_argument("event", choices=["start", "phase", "note", "end"])
    p.add_argument("id")
    p.add_argument("--label")
    p.add_argument("--doing")
    p.add_argument("--eta", type=float, help="ETA guess in MINUTES")
    p.add_argument("--total", type=float)
    p.add_argument("--unit")
    p.add_argument("--done", type=float)
    p.add_argument("--owner", help="who owns this row: the project or the parent chat")
    p.add_argument("--project", help="alias for --owner: the project this work belongs to")
    p.add_argument("--kind", help="section for this row; set it on start, it sticks")
    p.add_argument("--outcome", choices=["done", "failed", "abandoned"])
    a = p.parse_args()

    # kind is NOT defaulted here on purpose: every append carries it, and the collector
    # takes the newest value per field, so a default would silently re-file a row that
    # start already placed (a session row became a subagent row). Pass it, or omit it and
    # let the collector fall back to subagent.
    rec = {"id": a.id, "event": a.event}
    for src, dst in (("label", "label"), ("doing", "doing"), ("eta", "eta_min"),
                     ("total", "total"), ("unit", "unit"), ("done", "done"),
                     ("owner", "owner"), ("project", "project"), ("outcome", "outcome"),
                     ("kind", "kind")):
        v = getattr(a, src)
        if v is not None:
            rec[dst] = v
    append(rec)
    print(json.dumps({"ok": True, "wrote": rec}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
