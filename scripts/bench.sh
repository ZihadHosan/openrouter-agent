#!/usr/bin/env bash
# Lightweight smoke benchmark — run from repo root with extension dev host open.
# Usage: ./scripts/bench.sh
set -euo pipefail
echo "OpenRouter Agent bench (manual)"
echo "1. Enable openrouterAgent.debugPerformance or DEBUG_PERF=1"
echo "2. Open chat, send a short message 3x, check Developer Console for [perf] lines"
echo "3. Target: contextGather < 1500ms, first token < 2000ms on warm connection"
