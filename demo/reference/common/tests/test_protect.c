/*
 * Tests for work order BMS-1: over-temperature protection.
 * Test names start with the acceptance criterion they provide evidence for (test_ac1_..., test_ac2_...).
 *
 * AC-1  Any cell at 45.0 C or higher: charge path opens within 1 s, event logged with timestamp and sensor ID.
 * AC-2  Any cell at 60.0 C or higher: discharge path opens within 1 s, event logged.
 * AC-3  Charge path re-enabled only after all cells are at 40.0 C or lower (5.0 C hysteresis);
 *       at most one open/close cycle while the temperature oscillates between 43.0 C and 46.0 C.
 * AC-4  Open or short circuit on a sensor: fault reported, both paths open, safe state until the fault
 *       is cleared and the sensor passes a plausibility check.
 *
 * Demo only, not design guidance.
 */
#include <stddef.h>

#include "bms_protect.h"
#include "test_framework.h"
#include "test_harness.h"

static bool find_last_event(bms_event_type_t type, bms_log_entry_t *found)
{
    bool seen = false;
    for (size_t i = 0; i < bms_log_count(); i++) {
        bms_log_entry_t entry;
        if (bms_log_get(i, &entry) && entry.type == type) {
            *found = entry;
            seen = true;
        }
    }
    return seen;
}

static size_t count_events(bms_event_type_t type)
{
    size_t count = 0;
    for (size_t i = 0; i < bms_log_count(); i++) {
        bms_log_entry_t entry;
        if (bms_log_get(i, &entry) && entry.type == type) {
            count++;
        }
    }
    return count;
}

/* ---- AC-1: charge path opens at 45.0 C ---- */

TEST(test_ac1_charge_path_stays_closed_below_45c)
{
    harness_reset();
    harness_set_temp_dc(1, 449);
    harness_run_ms(2000);
    CHECK_MSG(harness_path_closed(BMS_PATH_CHARGE), "charge path opened below 45.0 C");
    CHECK_EQ(0, harness_open_count(BMS_PATH_CHARGE));
}

TEST(test_ac1_charge_path_opens_within_1s_at_45c)
{
    harness_reset();
    harness_run_ms(500);
    harness_set_temp_dc(1, 450);
    const uint32_t reached_at_ms = harness_now_ms();
    harness_run_ms(1000);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path still closed 1 s after a cell reached 45.0 C");
    CHECK_MSG(harness_last_open_ms(BMS_PATH_CHARGE) - reached_at_ms <= 1000, "charge path opened later than 1 s");
    CHECK_EQ(1, harness_open_count(BMS_PATH_CHARGE));
}

TEST(test_ac1_any_single_cell_opens_charge_path)
{
    for (uint8_t sensor = 0; sensor < BMS_SENSOR_COUNT; sensor++) {
        harness_reset();
        harness_set_temp_dc(sensor, 455);
        harness_run_ms(1000);
        CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "one hot cell did not open the charge path");
    }
}

TEST(test_ac1_charge_open_logged_with_timestamp_and_sensor_id)
{
    bms_log_entry_t entry;
    harness_reset();
    harness_run_ms(300);
    harness_set_temp_dc(2, 452);
    harness_run_ms(BMS_TICK_PERIOD_MS);
    CHECK(find_last_event(BMS_EVT_CHARGE_OPENED_OVERTEMP, &entry));
    CHECK_EQ(400, entry.timestamp_ms);
    CHECK_EQ(2, entry.sensor_id);
    CHECK_EQ(452, entry.value_dc);
    /* The event is logged once, not on every tick while the cell stays hot. */
    harness_run_ms(1000);
    CHECK_EQ(1, count_events(BMS_EVT_CHARGE_OPENED_OVERTEMP));
}

/* ---- AC-2: discharge path opens at 60.0 C ---- */

TEST(test_ac2_discharge_path_stays_closed_below_60c)
{
    harness_reset();
    harness_set_temp_dc(0, 599);
    harness_run_ms(2000);
    CHECK_MSG(harness_path_closed(BMS_PATH_DISCHARGE), "discharge path opened below 60.0 C");
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path should already be open at 59.9 C (AC-1)");
}

TEST(test_ac2_discharge_path_opens_within_1s_at_60c)
{
    harness_reset();
    harness_run_ms(500);
    harness_set_temp_dc(3, 600);
    const uint32_t reached_at_ms = harness_now_ms();
    harness_run_ms(1000);
    CHECK_MSG(!harness_path_closed(BMS_PATH_DISCHARGE), "discharge path still closed 1 s after a cell reached 60.0 C");
    CHECK_MSG(harness_last_open_ms(BMS_PATH_DISCHARGE) - reached_at_ms <= 1000, "discharge path opened later than 1 s");
    CHECK_EQ(1, harness_open_count(BMS_PATH_DISCHARGE));
}

TEST(test_ac2_discharge_open_is_logged)
{
    bms_log_entry_t entry;
    harness_reset();
    harness_set_temp_dc(3, 605);
    harness_run_ms(BMS_TICK_PERIOD_MS);
    CHECK(find_last_event(BMS_EVT_DISCHARGE_OPENED_OVERTEMP, &entry));
    CHECK_EQ(100, entry.timestamp_ms);
    CHECK_EQ(3, entry.sensor_id);
}

/* The work order does not specify recovery for the discharge path; the demo reuses the 5.0 C band. */
TEST(test_ac2_discharge_path_recovers_after_cooldown)
{
    harness_reset();
    harness_set_temp_dc(0, 610);
    harness_run_ms(1000);
    CHECK(!harness_path_closed(BMS_PATH_DISCHARGE));
    harness_set_temp_dc(0, 560);
    harness_run_ms(1000);
    CHECK_MSG(!harness_path_closed(BMS_PATH_DISCHARGE), "discharge path re-closed at 56.0 C, before the 55.0 C recovery point");
    harness_set_temp_dc(0, 550);
    harness_run_ms(BMS_TICK_PERIOD_MS);
    CHECK_MSG(harness_path_closed(BMS_PATH_DISCHARGE), "discharge path still open at 55.0 C");
}

/* ---- AC-3: charge path re-enable needs hysteresis ---- */

TEST(test_ac3_charge_path_stays_open_between_41c_and_44c)
{
    harness_reset();
    harness_set_temp_dc(0, 460);
    harness_run_ms(500);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path did not open at 46.0 C");
    harness_set_temp_dc(0, 440);
    harness_run_ms(1000);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path re-closed at 44.0 C; it must stay open until 40.0 C");
    harness_set_temp_dc(0, 410);
    harness_run_ms(1000);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path re-closed at 41.0 C; it must stay open until 40.0 C");
    CHECK_EQ(0, harness_close_count(BMS_PATH_CHARGE));
}

TEST(test_ac3_charge_path_reenables_at_40c)
{
    bms_log_entry_t entry;
    harness_reset();
    harness_set_temp_dc(0, 460);
    harness_run_ms(500);
    harness_set_temp_dc(0, 400);
    harness_run_ms(500);
    CHECK_MSG(harness_path_closed(BMS_PATH_CHARGE), "charge path still open at 40.0 C");
    CHECK_EQ(1, harness_open_count(BMS_PATH_CHARGE));
    CHECK_EQ(1, harness_close_count(BMS_PATH_CHARGE));
    CHECK(find_last_event(BMS_EVT_CHARGE_REENABLED, &entry));
}

TEST(test_ac3_charge_path_waits_for_all_cells)
{
    harness_reset();
    harness_set_temp_dc(0, 460);
    harness_run_ms(500);
    harness_set_temp_dc(0, 395);
    harness_set_temp_dc(1, 420);
    harness_run_ms(1000);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path re-closed while one cell was still at 42.0 C");
    harness_set_temp_dc(1, 400);
    harness_run_ms(BMS_TICK_PERIOD_MS);
    CHECK_MSG(harness_path_closed(BMS_PATH_CHARGE), "charge path still open with all cells at or below 40.0 C");
}

TEST(test_ac3_oscillation_43c_46c_opens_charge_path_only_once)
{
    harness_reset();
    harness_set_temp_dc(0, 430);
    harness_run_ms(1000);
    for (int cycle = 0; cycle < 10; cycle++) {
        harness_set_temp_dc(0, 460);
        harness_run_ms(500);
        harness_set_temp_dc(0, 430);
        harness_run_ms(500);
    }
    /* AC-3: no more than one open/close cycle while the temperature oscillates between 43.0 C and 46.0 C. */
    CHECK_EQ(1, harness_open_count(BMS_PATH_CHARGE));
    CHECK_EQ(0, harness_close_count(BMS_PATH_CHARGE));
}

/* ---- AC-4: sensor open or short circuit ---- */

TEST(test_ac4_open_circuit_opens_both_paths)
{
    harness_reset();
    harness_set_sensor_status(1, BMS_SENSOR_OPEN);
    harness_run_ms(1000);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path still closed with an open-circuit sensor");
    CHECK_MSG(!harness_path_closed(BMS_PATH_DISCHARGE), "discharge path still closed with an open-circuit sensor");
    CHECK(bms_protect_fault_active());
    CHECK_EQ(1u << 1, bms_protect_fault_mask());
}

TEST(test_ac4_short_circuit_opens_both_paths)
{
    harness_reset();
    harness_set_sensor_status(3, BMS_SENSOR_SHORT);
    harness_run_ms(1000);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path still closed with a shorted sensor");
    CHECK_MSG(!harness_path_closed(BMS_PATH_DISCHARGE), "discharge path still closed with a shorted sensor");
    CHECK_EQ(1u << 3, bms_protect_fault_mask());
}

TEST(test_ac4_fault_is_logged_once_with_sensor_id)
{
    bms_log_entry_t entry;
    harness_reset();
    harness_set_sensor_status(2, BMS_SENSOR_OPEN);
    harness_run_ms(2000);
    CHECK(find_last_event(BMS_EVT_SENSOR_FAULT, &entry));
    CHECK_EQ(100, entry.timestamp_ms);
    CHECK_EQ(2, entry.sensor_id);
    CHECK_EQ(1, count_events(BMS_EVT_SENSOR_FAULT));
}

TEST(test_ac4_implausible_reading_is_a_fault)
{
    harness_reset();
    harness_set_temp_dc(0, 1300);  /* valid status, but above the plausible window */
    harness_run_ms(500);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path closed with an implausible reading");
    CHECK_MSG(!harness_path_closed(BMS_PATH_DISCHARGE), "discharge path closed with an implausible reading");
    CHECK_EQ(1u << 0, bms_protect_fault_mask());
}

TEST(test_ac4_fault_stays_latched_until_cleared)
{
    harness_reset();
    harness_set_sensor_status(0, BMS_SENSOR_OPEN);
    harness_run_ms(500);
    harness_set_sensor_status(0, BMS_SENSOR_OK);
    harness_run_ms(2000);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path re-closed without a fault clear request");
    CHECK_MSG(!harness_path_closed(BMS_PATH_DISCHARGE), "discharge path re-closed without a fault clear request");
    CHECK(bms_protect_fault_active());
}

TEST(test_ac4_clear_needs_consecutive_plausible_samples)
{
    harness_reset();
    harness_set_sensor_status(0, BMS_SENSOR_SHORT);
    harness_run_ms(300);
    harness_set_sensor_status(0, BMS_SENSOR_OK);
    bms_protect_request_fault_clear();
    harness_run_ms(2 * BMS_TICK_PERIOD_MS);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "paths re-closed after only 2 plausible samples");
    /* One bad sample restarts the count. */
    harness_set_sensor_status(0, BMS_SENSOR_SHORT);
    harness_run_ms(BMS_TICK_PERIOD_MS);
    harness_set_sensor_status(0, BMS_SENSOR_OK);
    harness_run_ms(2 * BMS_TICK_PERIOD_MS);
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "count did not restart after an implausible sample");
    harness_run_ms(BMS_TICK_PERIOD_MS);
    CHECK_MSG(harness_path_closed(BMS_PATH_CHARGE), "charge path still open after 3 consecutive plausible samples");
    CHECK_MSG(harness_path_closed(BMS_PATH_DISCHARGE), "discharge path still open after 3 consecutive plausible samples");
    CHECK(!bms_protect_fault_active());
    CHECK_EQ(1, count_events(BMS_EVT_SENSOR_FAULT_CLEARED));
}

TEST(test_ac4_over_temperature_still_blocks_charge_after_fault_clears)
{
    harness_reset();
    harness_set_temp_dc(1, 460);
    harness_set_sensor_status(0, BMS_SENSOR_OPEN);
    harness_run_ms(500);
    harness_set_sensor_status(0, BMS_SENSOR_OK);
    bms_protect_request_fault_clear();
    harness_run_ms(3 * BMS_TICK_PERIOD_MS);
    CHECK(!bms_protect_fault_active());
    CHECK_MSG(harness_path_closed(BMS_PATH_DISCHARGE), "discharge path should close again at 46.0 C");
    CHECK_MSG(!harness_path_closed(BMS_PATH_CHARGE), "charge path must stay open while a cell is at 46.0 C");
}
