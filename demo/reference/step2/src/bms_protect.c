#include "bms_protect.h"

#include <string.h>

#include "bms_log.h"

/* Over-temperature latches: set when the open threshold is reached, cleared with hysteresis. */
static bool s_charge_blocked;
static bool s_discharge_blocked;

/* Sensor faults are latched until a person asks for them to be cleared and the sensor passes the plausibility check. */
static uint32_t s_fault_mask;
static uint8_t s_good_samples[BMS_SENSOR_COUNT];
static bool s_clear_requested;

void bms_protect_init(void)
{
    s_charge_blocked = false;
    s_discharge_blocked = false;
    s_fault_mask = 0;
    s_clear_requested = false;
    memset(s_good_samples, 0, sizeof s_good_samples);
}

static bool plausible(bms_sensor_status_t status, int16_t temp_dc)
{
    return status == BMS_SENSOR_OK && temp_dc >= BMS_PLAUSIBLE_MIN_DC && temp_dc <= BMS_PLAUSIBLE_MAX_DC;
}

/* AC-4: latch faults, and clear them only on request after consecutive plausible samples. */
static void update_faults(uint32_t now_ms, const int16_t *temp_dc, const bms_sensor_status_t *status)
{
    for (uint8_t i = 0; i < BMS_SENSOR_COUNT; i++) {
        const uint32_t bit = 1u << i;
        if (!plausible(status[i], temp_dc[i])) {
            s_good_samples[i] = 0;
            if ((s_fault_mask & bit) == 0) {
                s_fault_mask |= bit;
                bms_log_record(BMS_EVT_SENSOR_FAULT, now_ms, i, 0);
            }
        } else if ((s_fault_mask & bit) != 0 && s_clear_requested) {
            s_good_samples[i]++;
            if (s_good_samples[i] >= BMS_PLAUSIBLE_SAMPLES) {
                s_fault_mask &= ~bit;
                s_good_samples[i] = 0;
                bms_log_record(BMS_EVT_SENSOR_FAULT_CLEARED, now_ms, i, temp_dc[i]);
            }
        } else {
            s_good_samples[i] = 0;
        }
    }
    if (s_fault_mask == 0) {
        s_clear_requested = false;
    }
}

bms_path_command_t bms_protect_evaluate(uint32_t now_ms,
                                        const int16_t temp_dc[BMS_SENSOR_COUNT],
                                        const bms_sensor_status_t status[BMS_SENSOR_COUNT])
{
    update_faults(now_ms, temp_dc, status);

    /* Hottest sensor among those without a fault. A faulty sensor is never read as a safe temperature. */
    bool have_reading = false;
    int16_t max_dc = 0;
    uint8_t hottest = BMS_NO_SENSOR;
    for (uint8_t i = 0; i < BMS_SENSOR_COUNT; i++) {
        if ((s_fault_mask & (1u << i)) != 0) {
            continue;
        }
        if (!have_reading || temp_dc[i] > max_dc) {
            have_reading = true;
            max_dc = temp_dc[i];
            hottest = i;
        }
    }

    if (have_reading) {
        /* AC-1 and AC-3: charge path. Open at the threshold, re-enable only after the hysteresis band. */
        if (!s_charge_blocked && max_dc >= BMS_CHARGE_OPEN_DC) {
            s_charge_blocked = true;
            bms_log_record(BMS_EVT_CHARGE_OPENED_OVERTEMP, now_ms, hottest, max_dc);
        } else if (s_charge_blocked && max_dc <= BMS_CHARGE_OPEN_DC - BMS_HYSTERESIS_DC) {
            s_charge_blocked = false;
            bms_log_record(BMS_EVT_CHARGE_REENABLED, now_ms, hottest, max_dc);
        }

        /* AC-2: discharge path. The same hysteresis band is a demo assumption; the work order does not specify recovery. */
        if (!s_discharge_blocked && max_dc >= BMS_DISCHARGE_OPEN_DC) {
            s_discharge_blocked = true;
            bms_log_record(BMS_EVT_DISCHARGE_OPENED_OVERTEMP, now_ms, hottest, max_dc);
        } else if (s_discharge_blocked && max_dc <= BMS_DISCHARGE_OPEN_DC - BMS_HYSTERESIS_DC) {
            s_discharge_blocked = false;
            bms_log_record(BMS_EVT_DISCHARGE_REENABLED, now_ms, hottest, max_dc);
        }
    }

    /* AC-4: any latched sensor fault is the safe state, with both paths open. */
    const bool safe = s_fault_mask == 0;
    const bms_path_command_t command = {
        .charge_closed = safe && !s_charge_blocked,
        .discharge_closed = safe && !s_discharge_blocked,
    };
    return command;
}

void bms_protect_request_fault_clear(void)
{
    if (s_fault_mask != 0) {
        s_clear_requested = true;
    }
}

uint32_t bms_protect_fault_mask(void)
{
    return s_fault_mask;
}

bool bms_protect_fault_active(void)
{
    return s_fault_mask != 0;
}
