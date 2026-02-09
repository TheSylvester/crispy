#!/bin/bash
AGENTS="super-agent codex-agent gemini-agent cursor-agent"
count=0
echo "=== Multi-Vendor Agent Sessions (Last 48h) ==="
echo ""
for dir in "$HOME/.claude/projects/-home-silver-dev-crispy/" "$HOME/.claude/projects/-home-silver-dev-leto/"; do
  if echo "$dir" | grep -q crispy; then repo="crispy"; else repo="leto"; fi
  for file in $(find "$dir" -maxdepth 1 -name "*.jsonl" -mmin -2880 2>/dev/null); do
    found=""
    for agent in $AGENTS; do
      if grep -q "\"$agent\"" "$file" 2>/dev/null; then
        found="$found $agent"
      fi
    done
    agent_count=$(echo $found | wc -w)
    if [ "$agent_count" -ge 2 ]; then
      session_id=$(basename "$file" .jsonl)
      echo "[$repo] $session_id"
      echo "  Agents:$found"
      echo ""
      count=$((count + 1))
    fi
  done
done
echo "=== Summary ==="
echo "Total multi-vendor sessions: $count"
