/* Tests for start-up and sampling (bms_core.c). */
#include "test_framework.h"
#include "test_harness.h"

TEST(test_core_init_closes_both_paths)
{
    harness_reset();
    CHECK(harness_path_closed(BMS_PATH_CHARGE));
    CHECK(harness_path_closed(BMS_PATH_DISCHARGE));
    CHECK(bms_path_closed(BMS_PATH_CHARGE));
    CHECK(bms_path_closed(BMS_PATH_DISCHARGE));
}

TEST(test_core_init_logs_boot_event)
{
    bms_log_entry_t entry;
    harness_reset();
    CHECK_EQ(1, bms_log_count());
    CHECK(bms_log_get(0, &entry));
    CHECK_EQ(BMS_EVT_BOOT, entry.type);
    CHECK_EQ(0, entry.timestamp_ms);
    CHECK_EQ(BMS_NO_SENSOR, entry.sensor_id);
}

TEST(test_core_tick_tracks_hottest_cell)
{
    harness_reset();
    harness_set_temp_dc(0, 250);
    harness_set_temp_dc(1, 310);
    harness_set_temp_dc(2, 280);
    harness_set_temp_dc(3, 260);
    harness_run_ms(BMS_TICK_PERIOD_MS);
    CHECK_EQ(310, bms_max_temp_dc());
    harness_set_temp_dc(1, 240);
    harness_run_ms(BMS_TICK_PERIOD_MS);
    CHECK_EQ(280, bms_max_temp_dc());
}
