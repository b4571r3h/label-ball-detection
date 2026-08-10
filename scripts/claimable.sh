#!/usr/bin/env bash
# Print claimable issues: open, ready-for-agent, no assignee, all blockers closed.
# Blockers are the "- #N" lines in an issue's "## Blocked by" section.
# Parent tickets (label "spec" or "wayfinder:map") are an index, not work.
# Uses gh's built-in jq; no local jq install is necessary.
# Windows: use scripts/claimable.ps1 (same query).
set -euo pipefail

QUERY='
(reduce .[] as $i ({}; .[$i.number | tostring] = $i.state)) as $state
| [ .[]
    | select(.state == "OPEN")
    | select(any(.labels[]; .name == "ready-for-agent"))
    | select(all(.labels[]; .name != "spec" and .name != "wayfinder:map"))
    | select(.assignees | length == 0)
    | . + {blockers: ([.body // "" | scan("(?i)##+[ ]*blocked by[\\s\\S]*")]
        | first // "" | [scan("#(\\d+)")] | map(.[0]))}
    | select(all(.blockers[]; $state[.] != "OPEN"))
  ]
| sort_by(.number)[]
| "#\(.number)\t\(.title)"
'

gh issue list --state all --limit 500 \
  --json number,state,title,assignees,body,labels \
  --jq "$QUERY"
