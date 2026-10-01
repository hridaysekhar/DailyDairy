#!/bin/bash
cd "$(dirname "$0")"
mkdir -p logs
echo "==== $(date) ====" >> logs/scheduler.log
HEADLESS=true node fetch-diary.js >> logs/scheduler.log 2>&1
echo "" >> logs/scheduler.log
