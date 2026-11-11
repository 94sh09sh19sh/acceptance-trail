/* Tests for the ring-buffer event log (bms_log.c). */
#include "bms_log.h"
#include "test_framework.h"

TEST(test_log_records_entry_fields)
{
    bms_log_entry_t entry;
    bms_log_clear();
    bms_log_record(BMS_EVT_BOOT, 1234, 2, 456);
    CHECK_EQ(1, bms_log_count());
    CHECK(bms_log_get(0, &entry));
    CHECK_EQ(BMS_EVT_BOOT, entry.type);
    CHECK_EQ(1234, entry.timestamp_ms);
    CHECK_EQ(2, entry.sensor_id);
    CHECK_EQ(456, entry.value_dc);
}

TEST(test_log_keeps_newest_entries_when_full)
{
    bms_log_entry_t entry;
    bms_log_clear();
    for (uint32_t i = 0; i < 20; i++) {
        bms_log_record(BMS_EVT_BOOT, i, 0, 0);
    }
    CHECK_EQ(BMS_LOG_CAPACITY, bms_log_count());
    CHECK(bms_log_get(0, &entry));
    CHECK_EQ(4, entry.timestamp_ms);  /* entries 0 to 3 were overwritten */
    CHECK(bms_log_get(BMS_LOG_CAPACITY - 1, &entry));
    CHECK_EQ(19, entry.timestamp_ms);
}

TEST(test_log_get_rejects_out_of_range_index)
{
    bms_log_entry_t entry;
    bms_log_clear();
    CHECK(!bms_log_get(0, &entry));
    bms_log_record(BMS_EVT_BOOT, 1, 0, 0);
    CHECK(!bms_log_get(1, &entry));
}
