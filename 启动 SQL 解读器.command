#!/bin/zsh
set -e
# Resolve this file's real location, including a Desktop symlink.
open "${0:A:h}/index.html"
