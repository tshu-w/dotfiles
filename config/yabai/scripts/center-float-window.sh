#!/usr/bin/env bash

read -r W H <<< $(echo $(yabai -m query --displays --display | jq ".frame | .w, .h"))
read -r w h <<< $(echo $(yabai -m query --windows --window | jq ".frame | .w, .h"))
x=$(((W - w) / 2))
y=$(((H - 22 - h) / 2 + 22))
yabai -m window --move abs:$x:$y
