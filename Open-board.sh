#!/bin/sh
set -eu
board_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
if [ -x "$board_dir/runtime/node" ]; then
    node_bin="$board_dir/runtime/node"
elif command -v node >/dev/null 2>&1; then
    node_bin=node
else
    echo 'Node.js не найден. Распакуйте переносимую сборку для своей системы целиком.' >&2
    exit 1
fi
exec "$node_bin" "$board_dir/open-board.mjs" "$@"
