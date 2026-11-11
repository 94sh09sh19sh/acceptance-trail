#ifndef BMS_HAL_H
#define BMS_HAL_H

#include <stdbool.h>
#include <stdint.h>

#include "bms_types.h"

/*
 * Hardware abstraction layer. The board port implements these two functions;
 * the unit tests provide a fake in tests/test_harness.c.
 */

/*
 * Reads one temperature sensor.
 * On BMS_SENSOR_OK, *temp_dc holds the temperature in deci-degrees Celsius.
 * On any other status, *temp_dc must not be used.
 */
bms_sensor_status_t bms_hal_read_temp(uint8_t sensor_id, int16_t *temp_dc);

/* Drives one power path switch output: closed = current may flow. */
void bms_hal_set_path(bms_path_t path, bool closed);

#endif /* BMS_HAL_H */
