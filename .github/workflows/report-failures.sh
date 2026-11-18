#!/usr/bin/env bash
# Lists the failing tests of a run in the job summary and as annotations (which anyone can read on a
# public repository, without the log download that needs admin rights). Argument: the test log.
log="$1"
[ -f "$log" ] || exit 0
lines=$(grep -nE '^\s*not ok |^FAILED |error: |^\s+(expected|actual):|AssertionError|Error:' "$log" | head -80)
{
  echo '### Failing tests'
  echo '```'
  echo "$lines"
  echo '```'
} >> "$GITHUB_STEP_SUMMARY"
# GitHub keeps 10 error annotations per step: send the lines in up to 10 groups of 8
i=0
group=""
while IFS= read -r line; do
  group+="${line}%0A"
  i=$((i + 1))
  if [ $((i % 8)) -eq 0 ]; then
    echo "::error title=failing tests::${group}"
    group=""
  fi
done <<< "$lines"
[ -n "$group" ] && echo "::error title=failing tests::${group}"
exit 0
