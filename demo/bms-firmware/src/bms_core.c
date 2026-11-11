#include "bms_core.h"

#include <stdint.h>

#include "bms_config.h"
#include "bms_hal.h"
#include "bms_log.h"

static int16_t s_temp_dc[BMS_SENSOR_COUNT];
static bms_sensor_status_t s_status[BMS_SENSOR_COUNT];
static int16_t s_max_temp_dc = INT16_MIN;
static bool s_path_closed[BMS_PATH_COUNT];

void bms_init(uint32_t now_ms)
{
    bms_log_clear();
    for (uint8_t i = 0; i < BMS_SENSOR_COUNT; i++) {
        s_temp_dc[i] = 0;
        s_status[i] = BMS_SENSOR_OK;
    }
    s_max_temp_dc = INT16_MIN;
    for (int p = 0; p < (int)BMS_PATH_COUNT; p++) {
        s_path_closed[p] = true;
        bms_hal_set_path((bms_path_t)p, true);
    }
    bms_log_record(BMS_EVT_BOOT, now_ms, BMS_NO_SENSOR, 0);
}

void bms_tick(uint32_t now_ms)
{
    (void)now_ms;
    s_max_temp_dc = INT16_MIN;
    for (uint8_t i = 0; i < BMS_SENSOR_COUNT; i++) {
        s_status[i] = bms_hal_read_temp(i, &s_temp_dc[i]);
        if (s_status[i] == BMS_SENSOR_OK && s_temp_dc[i] > s_max_temp_dc) {
            s_max_temp_dc = s_temp_dc[i];
        }
    }
}

int16_t bms_max_temp_dc(void)
{
    return s_max_temp_dc;
}

bool bms_path_closed(bms_path_t path)
{
    return s_path_closed[path];
}
