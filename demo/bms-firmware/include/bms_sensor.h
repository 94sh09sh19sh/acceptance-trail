#ifndef BMS_SENSOR_H
#define BMS_SENSOR_H

#include <stdint.h>

#include "bms_types.h"

/*
 * Converts a raw 10-bit ADC count from an NTC thermistor divider into deci-degrees
 * Celsius. A board port calls this from bms_hal_read_temp().
 *
 * Counts fall as the temperature rises. Counts at the very bottom of the range
 * are reported as BMS_SENSOR_SHORT, counts at the very top as BMS_SENSOR_OPEN;
 * *temp_dc is only written for BMS_SENSOR_OK. Counts outside the table but not
 * open or short are clamped to the nearest table end.
 *
 * The conversion table is illustrative. Demo only, not design guidance.
 */
bms_sensor_status_t bms_sensor_from_adc(uint16_t raw, int16_t *temp_dc);

#endif /* BMS_SENSOR_H */
