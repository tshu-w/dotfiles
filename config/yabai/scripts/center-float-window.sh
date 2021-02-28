#!/usr/bin/env bash

read -r X Y W H <<< $(echo $(yabai -m query --displays --display | jq ".frame | .x, .y, .w, .h"))
read -r w h <<< $(echo $(yabai -m query --windows --window | jq ".frame | .w, .h"))
x=$((((W - w) / 2)+X))
y=$((((H - 22 - h) / 2 + 22)+Y))
yabai -m window --move abs:$x:$y
