#!/usr/bin/env bash
# Resets the demo firmware to its baseline, applies a reference solution step, or checks the whole fixture.
#
#   ./demo.sh reset    restore bms-firmware/ to the baseline (no over-temperature protection)
#   ./demo.sh step1    reset, then apply reference step 1 (AC-1 to AC-3 implemented, AC-3 deliberately wrong)
#   ./demo.sh step2    reset, then apply reference step 2 (all four criteria correct)
#   ./demo.sh verify   run baseline, step 1 and step 2 in turn, check the expected results, then reset
#
# The working folder is overwritten: anything inside bms-firmware/ that is not in the baseline is deleted.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$HERE/bms-firmware"
REF="$HERE/reference"

reset_baseline() {
    [ -d "$REF/baseline" ] || { echo "demo.sh: missing $REF/baseline" >&2; exit 2; }
    mkdir -p "$TARGET"
    find "$TARGET" -mindepth 1 -delete
    cp -a "$REF/baseline/." "$TARGET/"
}

apply_step() {
    local step="$1"
    [ -d "$REF/step$step" ] || { echo "demo.sh: missing $REF/step$step" >&2; exit 2; }
    reset_baseline
    cp -a "$REF/common/." "$TARGET/"
    cp -a "$REF/step$step/." "$TARGET/"
}

# Runs the tests in bms-firmware/ and stores the output in $OUT and the exit code in $RC.
run_suite() {
    RC=0
    OUT="$(cd "$TARGET" && ./run_tests.sh 2>&1)" || RC=$?
    grep -E '^(FAIL|SUMMARY)' <<<"$OUT" || true
}

verify() {
    local problems=0
    if ! diff -rq -x build "$REF/baseline" "$TARGET" >/dev/null 2>&1; then
        echo "note: bms-firmware differs from reference/baseline (verify overwrites it)"
    fi

    echo "== baseline =="
    reset_baseline
    run_suite
    if [ "$RC" -ne 0 ] || ! grep -q ' 0 failed$' <<<"$OUT"; then
        echo "UNEXPECTED: baseline must build and pass all tests"; problems=1
    fi

    echo "== step1 =="
    apply_step 1
    run_suite
    local failing
    failing="$(grep -E '^FAIL' <<<"$OUT" | grep -vc 'test_ac3_' || true)"
    if [ "$RC" -eq 0 ] || ! grep -q '^FAIL test_ac3_' <<<"$OUT" || [ "$failing" -ne 0 ]; then
        echo "UNEXPECTED: step1 must fail only test_ac3_* tests"; problems=1
    fi

    echo "== step2 =="
    apply_step 2
    run_suite
    if [ "$RC" -ne 0 ] || ! grep -q ' 0 failed$' <<<"$OUT"; then
        echo "UNEXPECTED: step2 must pass all tests"; problems=1
    fi

    echo "== reset =="
    reset_baseline
    if diff -r "$REF/baseline" "$TARGET" >/dev/null 2>&1; then
        echo "bms-firmware matches the baseline"
    else
        echo "UNEXPECTED: bms-firmware differs from the baseline after reset"; problems=1
    fi

    if [ "$problems" -eq 0 ]; then echo "verify: OK"; else echo "verify: FAILED"; exit 1; fi
}

case "${1:-}" in
    reset) reset_baseline; echo "bms-firmware restored to the baseline" ;;
    step1) apply_step 1; echo "reference step 1 applied" ;;
    step2) apply_step 2; echo "reference step 2 applied" ;;
    verify) verify ;;
    *) echo "usage: $0 reset|step1|step2|verify" >&2; exit 2 ;;
esac
