#ifndef BMS_PROTECT_H
#define BMS_PROTECT_H

#include <stdbool.h>
#include <stdint.h>

#include "bms_config.h"
#include "bms_types.h"

/*
 * Over-temperature protection and sensor fault handling (work order BMS-1).
 *
 * All numbers below are illustrative. Demo only, not design guidance.
 * Real thresholds come from the cell datasheet and the safety analysis.
 */

#define BMS_CHARGE_OPEN_DC     450   /* AC-1: open the charge path at 45.0 C or higher */
#define BMS_DISCHARGE_OPEN_DC  600   /* AC-2: open the discharge path at 60.0 C or higher */
#define BMS_HYSTERESIS_DC       50   /* AC-3: re-enable only 5.0 C below the open threshold */

/* AC-4: a sensor passes the plausibility check with a valid reading inside this window... */
#define BMS_PLAUSIBLE_MIN_DC  (-400)
#define BMS_PLAUSIBLE_MAX_DC   1250
/* ...for this many consecutive samples after a person requested the fault to be cleared. */
#define BMS_PLAUSIBLE_SAMPLES  3u

typedef struct {
    bool charge_closed;
    bool discharge_closed;
} bms_path_command_t;

void bms_protect_init(void);

/* Evaluates one sample of all sensors and returns the power path states to command. */
bms_path_command_t bms_protect_evaluate(uint32_t now_ms,
                                        const int16_t temp_dc[BMS_SENSOR_COUNT],
                                        const bms_sensor_status_t status[BMS_SENSOR_COUNT]);

/* Service request (not an automatic action): lets latched sensor faults clear once the sensors pass the plausibility check. */
void bms_protect_request_fault_clear(void);

/* Bit i is set while sensor i has a latched fault. */
uint32_t bms_protect_fault_mask(void);
bool bms_protect_fault_active(void);

#endif /* BMS_PROTECT_H */
