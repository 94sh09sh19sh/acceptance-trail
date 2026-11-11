#!/usr/bin/env bash
# Builds and runs the unit tests with plain gcc (C11, -Wall -Wextra -Werror).
# No make, no third-party framework. Usage: ./run_tests.sh [name-filter]
# Every src/*.c and tests/*.c file is compiled, so new files are picked up automatically.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

CC="${CC:-gcc}"
if ! command -v "$CC" >/dev/null 2>&1; then
    for candidate in /c/msys64/ucrt64/bin/gcc /ucrt64/bin/gcc; do
        if [ -x "$candidate" ]; then
            CC="$candidate"
            break
        fi
    done
fi
if ! command -v "$CC" >/dev/null 2>&1; then
    echo "run_tests.sh: gcc not found (set CC to a C compiler)" >&2
    exit 2
fi

mkdir -p build
EXE=build/bms_tests
case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) EXE=build/bms_tests.exe ;;
esac

"$CC" -std=c11 -Wall -Wextra -Werror -O0 -g -Iinclude -Itests src/*.c tests/*.c -o "$EXE"
"./$EXE" "$@"
