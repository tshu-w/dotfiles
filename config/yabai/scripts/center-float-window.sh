#!/usr/bin/env bash

read -r X Y W H <<< $(echo $(yabai -m query --displays --display | jq ".frame | .x, .y, .w, .h"))
read -r w h <<< $(echo $(yabai -m query --windows --window | jq ".frame | .w, .h"))
x=$(echo "scale=2;($W - $w) / 2 + $X" | bc)
y=$(echo "scale=2; ((($H - 22 - $h) / 2 + 22) + $Y)" | bc)
yabai -m window --move abs:$x:$y
