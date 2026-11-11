#include "bms_log.h"

static bms_log_entry_t s_entries[BMS_LOG_CAPACITY];
static size_t s_next;   /* slot the next entry is written to */
static size_t s_count;  /* number of valid entries */

void bms_log_clear(void)
{
    s_next = 0;
    s_count = 0;
}

void bms_log_record(bms_event_type_t type, uint32_t timestamp_ms, uint8_t sensor_id, int16_t value_dc)
{
    bms_log_entry_t *slot = &s_entries[s_next];
    slot->type = type;
    slot->timestamp_ms = timestamp_ms;
    slot->sensor_id = sensor_id;
    slot->value_dc = value_dc;
    s_next = (s_next + 1u) % BMS_LOG_CAPACITY;
    if (s_count < BMS_LOG_CAPACITY) {
        s_count++;
    }
}

size_t bms_log_count(void)
{
    return s_count;
}

bool bms_log_get(size_t index, bms_log_entry_t *entry)
{
    if (index >= s_count) {
        return false;
    }
    const size_t oldest = (s_next + BMS_LOG_CAPACITY - s_count) % BMS_LOG_CAPACITY;
    *entry = s_entries[(oldest + index) % BMS_LOG_CAPACITY];
    return true;
}
