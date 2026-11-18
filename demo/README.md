# Demo firmware: BMS over-temperature protection

A small C module for the Acceptance Trail demo. An external AI coding agent reads an approved work order from Jira, implements the requirement here, runs the tests, and reports evidence for each acceptance criterion.

**Demo only, not design guidance.** The module belongs to a fictional electric motorcycle battery management system. Every threshold, table and timing is illustrative. Real values come from the cell datasheet and the team's safety analysis. Nothing here claims compliance with any standard.

## Layout

- `bms-firmware/` is the working project and normally holds the baseline. `include/` and `src/` hold the hardware interface (`bms_hal.h`), ADC conversion, event log and sampling loop. `tests/` holds a minimal test macro header, a fake hardware harness and the tests.
- `reference/` holds the reference solutions and a pristine copy of the baseline. The agent must not read it.
- `demo.sh` resets the working project or applies a reference step.

## Run the tests

```sh
cd bms-firmware
./run_tests.sh              # build and run everything
./run_tests.sh ac3          # run only tests whose name contains "ac3"
```

Needs bash and gcc (C11). The script compiles every `src/*.c` and `tests/*.c` with `-Wall -Wextra -Werror`, so new files are picked up without editing a build file. Nothing is installed. Output goes to `build/`, which is git-ignored. The exit code is 0 only if every test passed.

```
PASS test_ac1_charge_path_opens_within_1s_at_45c
FAIL test_ac3_charge_path_stays_open_between_41c_and_44c
     tests/test_protect.c:153: charge path re-closed at 44.0 C; it must stay open until 40.0 C [CHECK(...)]
SUMMARY: 31 tests, 28 passed, 3 failed
```

Declare a test with `TEST(test_name) { ... }` in any file under `tests/`; it registers itself. `CHECK`, `CHECK_MSG` and `CHECK_EQ` end the test at the first failed check. Tests run sorted by name. Temperatures are integers in deci-degrees Celsius (`450` is 45.0 C).

## The baseline

Sampling works, but there is no protection. `bms_hal.h` is the interface to the hardware: temperature readings in, power path switches out (the tests supply a fake). `bms_sensor.c` converts ADC counts and detects open and short circuits. `bms_log.c` is a ring-buffer event log. `bms_core.c` closes both paths at start-up and samples every 100 ms, but `bms_tick()` never changes the switches afterwards. The 12 existing tests pass.

## The work order (Jira issue BMS-1)

| Criterion | Short form of the text | Tests in the reference solution |
|---|---|---|
| AC-1 | At 45 C or higher on any cell, the charge path opens within 1 s; the event is logged with timestamp and sensor ID | `test_ac1_charge_path_stays_closed_below_45c`, `test_ac1_charge_path_opens_within_1s_at_45c`, `test_ac1_any_single_cell_opens_charge_path`, `test_ac1_charge_open_logged_with_timestamp_and_sensor_id` |
| AC-2 | At 60 C or higher on any cell, the discharge path opens within 1 s; the event is logged | `test_ac2_discharge_path_stays_closed_below_60c`, `test_ac2_discharge_path_opens_within_1s_at_60c`, `test_ac2_discharge_open_is_logged`, `test_ac2_discharge_path_recovers_after_cooldown` |
| AC-3 | The charge path re-enables only after all cells reach 40 C or lower (5 C hysteresis), with at most one open/close cycle while the temperature oscillates between 43 C and 46 C | `test_ac3_charge_path_stays_open_between_41c_and_44c`, `test_ac3_charge_path_reenables_at_40c`, `test_ac3_charge_path_waits_for_all_cells`, `test_ac3_oscillation_43c_46c_opens_charge_path_only_once` |
| AC-4 | A sensor open or short circuit is reported as a fault, opens both paths, and keeps the safe state until the fault is cleared and the sensor passes a plausibility check | `test_ac4_open_circuit_opens_both_paths`, `test_ac4_short_circuit_opens_both_paths`, `test_ac4_fault_is_logged_once_with_sensor_id`, `test_ac4_implausible_reading_is_a_fault`, `test_ac4_fault_stays_latched_until_cleared`, `test_ac4_clear_needs_consecutive_plausible_samples`, `test_ac4_over_temperature_still_blocks_charge_after_fault_clears` |

The approved work order in Jira is the source of truth. It does not say how the discharge path recovers, so the reference reuses the 5 C band (a demo assumption, covered by one test).

## Reset and reference steps

```sh
./demo.sh reset     # restore bms-firmware/ to the baseline
./demo.sh step1     # reset, then apply reference step 1
./demo.sh step2     # reset, then apply reference step 2
./demo.sh verify    # run baseline, step 1 and step 2, check the expected results, reset
```

`reset` deletes everything inside `bms-firmware/` that is not in the baseline, then copies `reference/baseline/` back. `step1` and `step2` always start from a reset baseline, so they can be applied in any order.

| State | What it is | Expected result |
|---|---|---|
| Baseline | Sampling works, no protection | 12 tests, 12 passed, 0 failed |
| Step 1 | AC-1, AC-2 and AC-4 are correct. The charge path re-enables as soon as the temperature is below 45 C, with no hysteresis. | 31 tests, 28 passed, 3 failed; every failure is a `test_ac3_*` test |
| Step 2 | Step 1 with the re-enable condition fixed to "at or below 40 C" | 31 tests, 31 passed, 0 failed |

The only difference between the steps is one comparison in `src/bms_protect.c`. Both share the same tests (`reference/common/`), so the failure in step 1 is real evidence: the tests ran and found the defect.

## Using it in the demo

1. `./demo.sh reset`, then point the agent at `demo/bms-firmware/` only.
2. For a repeatable recording, apply `./demo.sh step1` in place of the agent's own work, run `./run_tests.sh`, and have the agent report AC-1, AC-2 and AC-4 as `pass` and AC-3 as `fail` with the real output excerpt.
3. Apply `./demo.sh step2`, run the tests again, and have the agent submit new evidence for AC-3. Only the latest evidence for a criterion counts.
4. Finish with `./demo.sh reset`.
