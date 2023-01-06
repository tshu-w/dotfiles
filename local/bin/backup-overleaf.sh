#!/usr/bin/env sh

HOST="overleaf.cipsup.cn"
PROJECT_ID="627220cc14ecd4008b9ae727"
DIRECTORY="$HOME/Library/CloudStorage/OneDrive-Personal/Backups/Overleaf/$PROJECT_ID"
OUTPUT="main_`date +"%Y-%m-%dT%H%M"`.zip"
COOKIE="s%3Ahy4xllZRaVhfWIGGCEi2ySCu5SHxzcWu.JdNLFEz3hbipwNaFLygLHp%2BNQ3TINvAA5jYA8nWPihk"

curl "http://$HOST/project/$PROJECT_ID/download/zip" \
     -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15" \
     -H "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" \
     -H "Accept-Language: en-US,en;q=0.9" \
     -H "Accept-Encoding: gzip, deflate" \
     -H "Upgrade-Insecure-Requests: 1" \
     -H "Cookie: sharelatex.sid=$COOKIE" \
     --output "$DIRECTORY/$OUTPUT" --create-dirs

find "$DIRECTORY/" -mindepth 1 -type f -mtime +2 -delete
