#!/bin/bash
cd "$(dirname "$0")"
mkdir -p logs
echo "==== $(date) ====" >> logs/scheduler.log

DATE_ARG="$1"
if [ -n "$DATE_ARG" ] && ! date -d "$DATE_ARG" >/dev/null 2>&1; then
  echo "Invalid date argument: \"$DATE_ARG\" — use e.g. \"2026-10-01\" or \"Oct 1\"" >> logs/scheduler.log
  exit 1
fi

HEADLESS=true node fetch-diary.js "$DATE_ARG" >> logs/scheduler.log 2>&1

if [ -d attachments ] && [ -n "$(ls -A attachments 2>/dev/null)" ]; then
  echo "Syncing attachments to Google Drive..." >> logs/scheduler.log
  rclone copy attachments/ gdrive:DailyDairyAttachments/ >> logs/scheduler.log 2>&1
fi

echo "" >> logs/scheduler.log
