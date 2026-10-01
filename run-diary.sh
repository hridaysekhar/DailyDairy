#!/bin/bash
cd "$(dirname "$0")"
mkdir -p logs
echo "==== $(date) ====" >> logs/scheduler.log
HEADLESS=true node fetch-diary.js >> logs/scheduler.log 2>&1

if [ -d attachments ] && [ -n "$(ls -A attachments 2>/dev/null)" ]; then
  echo "Syncing attachments to Google Drive..." >> logs/scheduler.log
  rclone copy attachments/ gdrive:DailyDairyAttachments/ >> logs/scheduler.log 2>&1
fi

echo "" >> logs/scheduler.log
