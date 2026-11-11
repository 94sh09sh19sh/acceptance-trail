#ifndef TEST_HARNESS_H
#define TEST_HARNESS_H

#include <stdbool.h>
#include <stdint.h>

#include "bms_config.h"
#include "bms_core.h"
#include "bms_log.h"
#include "bms_types.h"

/*
 * Fake hardware for the unit tests: simulated temperature sensors, simulated
 * power path switches, and a simulated clock that advances in BMS_TICK_PERIOD_MS steps.
 */

/* Fresh fake hardware (every sensor reads 25.0 C and is OK), clock at 0, then bms_init(0).
 * Switch counters start at zero after init. */
void harness_reset(void);

void harness_set_temp_dc(uint8_t sensor_id, int16_t temp_dc);
void harness_set_all_temp_dc(int16_t temp_dc);
void harness_set_sensor_status(uint8_t sensor_id, bms_sensor_status_t status);

/* Advances the clock by duration_ms and calls bms_tick() once per BMS_TICK_PERIOD_MS. */
void harness_run_ms(uint32_t duration_ms);
uint32_t harness_now_ms(void);

/* State of the simulated switch outputs, as last commanded through bms_hal_set_path(). */
bool harness_path_closed(bms_path_t path);
unsigned harness_open_count(bms_path_t path);   /* open commands since harness_reset() */
unsigned harness_close_count(bms_path_t path);  /* close commands since harness_reset() */
uint32_t harness_last_open_ms(bms_path_t path); /* clock value of the latest open command */

#endif /* TEST_HARNESS_H */
