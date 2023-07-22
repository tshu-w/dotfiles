#!/usr/bin/env python
# -*- coding: utf-8 -*-

import json

modifier_keys=[
    "caps_lock",
    "left_control",
    "left_shift",
    "left_option",
    "left_command",
    "right_control",
    "right_shift",
    "right_option",
    "right_command",
    "fn",
    "return_or_enter",
]

key_codes=[
    "spacebar",
    "caps_lock",
    "left_control",
    "left_shift",
    "left_option",
    "left_command",
    "right_control",
    "right_shift",
    "right_option",
    "right_command",
    "fn",
    "return_or_enter",
    "escape",
    "delete_or_backspace",
    "delete_forward",
    "tab",
    "spacebar",
    "hyphen",
    "equal_sign",
    "open_bracket",
    "close_bracket",
    "backslash",
    "non_us_pound",
    "semicolon",
    "quote",
    "grave_accent_and_tilde",
    "comma",
    "period",
    "slash",
    "non_us_backslash",
    "up_arrow",
    "down_arrow",
    "left_arrow",
    "right_arrow",
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
    "k",
    "l",
    "m",
    "n",
    "o",
    "p",
    "q",
    "r",
    "s",
    "t",
    "u",
    "v",
    "w",
    "x",
    "y",
    "z",
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "0",
    "f1",
    "f2",
    "f3",
    "f4",
    "f5",
    "f6",
    "f7",
    "f8",
    "f9",
    "f10",
    "f11",
    "f12",
]

key_code = None

for key_code in key_codes:
    dic = {
        "from": {
            "key_code": key_code,
        },
        "to": [
            {
                "set_variable": {
                    "name": "_spacefn_mode",
                    "value": 1
                }
            },
            {
                "key_code": key_code
            }
        ],
        "to_delayed_action": {
            "to_if_invoked": [
                {
                    "set_variable": {
                        "name": "_spacefn_mode",
                        "value": 0
                    }
                }
            ],
            "to_if_canceled": [
                {
                    "set_variable": {
                        "name": "_spacefn_mode",
                        "value": 0
                    }
                }
            ]
        },
        "parameters": {
            "basic.to_delayed_action_delay_milliseconds": 200
        },
        "type": "basic"
    }
    s = json.dumps(dic, indent=2)+','
    print(s)
