#ifndef BMS_CORE_H
#define BMS_CORE_H

#include <stdbool.h>
#include <stdint.h>

#include "bms_types.h"

/* Call once at start-up. Closes both power paths and logs a boot event. */
void bms_init(uint32_t now_ms);

/* Call every BMS_TICK_PERIOD_MS: samples all temperature sensors. */
void bms_tick(uint32_t now_ms);

/* Hottest valid reading of the last tick in deci-degrees Celsius, INT16_MIN if none was valid. */
int16_t bms_max_temp_dc(void);

/* Last commanded state of a power path: true means closed (current may flow). */
bool bms_path_closed(bms_path_t path);

#endif /* BMS_CORE_H */
