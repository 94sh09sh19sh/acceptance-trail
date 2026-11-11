#ifndef BMS_LOG_H
#define BMS_LOG_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* Small in-RAM event log: a ring buffer that keeps the newest entries. */

#define BMS_LOG_CAPACITY 16u

typedef enum {
    BMS_EVT_NONE = 0,
    BMS_EVT_BOOT = 1
} bms_event_type_t;

typedef struct {
    bms_event_type_t type;
    uint32_t timestamp_ms;
    uint8_t sensor_id;  /* BMS_NO_SENSOR when the event is not tied to a sensor */
    int16_t value_dc;   /* related temperature in deci-degrees Celsius, 0 if none */
} bms_log_entry_t;

void bms_log_clear(void);
void bms_log_record(bms_event_type_t type, uint32_t timestamp_ms, uint8_t sensor_id, int16_t value_dc);

/* Number of entries currently stored (at most BMS_LOG_CAPACITY). */
size_t bms_log_count(void);

/* Reads entry `index`, where 0 is the oldest stored entry. Returns false if out of range. */
bool bms_log_get(size_t index, bms_log_entry_t *entry);

#endif /* BMS_LOG_H */
