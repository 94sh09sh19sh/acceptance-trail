#include "test_harness.h"

#include "bms_hal.h"

static int16_t s_temp_dc[BMS_SENSOR_COUNT];
static bms_sensor_status_t s_status[BMS_SENSOR_COUNT];
static bool s_closed[BMS_PATH_COUNT];
static unsigned s_open_count[BMS_PATH_COUNT];
static unsigned s_close_count[BMS_PATH_COUNT];
static uint32_t s_last_open_ms[BMS_PATH_COUNT];
static uint32_t s_now_ms;

bms_sensor_status_t bms_hal_read_temp(uint8_t sensor_id, int16_t *temp_dc)
{
    *temp_dc = s_temp_dc[sensor_id];
    return s_status[sensor_id];
}

void bms_hal_set_path(bms_path_t path, bool closed)
{
    s_closed[path] = closed;
    if (closed) {
        s_close_count[path]++;
    } else {
        s_open_count[path]++;
        s_last_open_ms[path] = s_now_ms;
    }
}

void harness_reset(void)
{
    s_now_ms = 0;
    for (uint8_t i = 0; i < BMS_SENSOR_COUNT; i++) {
        s_temp_dc[i] = 250;
        s_status[i] = BMS_SENSOR_OK;
    }
    bms_init(s_now_ms);
    for (int p = 0; p < (int)BMS_PATH_COUNT; p++) {
        s_open_count[p] = 0;
        s_close_count[p] = 0;
        s_last_open_ms[p] = 0;
    }
}

void harness_set_temp_dc(uint8_t sensor_id, int16_t temp_dc)
{
    s_temp_dc[sensor_id] = temp_dc;
}

void harness_set_all_temp_dc(int16_t temp_dc)
{
    for (uint8_t i = 0; i < BMS_SENSOR_COUNT; i++) {
        s_temp_dc[i] = temp_dc;
    }
}

void harness_set_sensor_status(uint8_t sensor_id, bms_sensor_status_t status)
{
    s_status[sensor_id] = status;
}

void harness_run_ms(uint32_t duration_ms)
{
    for (uint32_t elapsed = 0; elapsed < duration_ms; elapsed += BMS_TICK_PERIOD_MS) {
        s_now_ms += BMS_TICK_PERIOD_MS;
        bms_tick(s_now_ms);
    }
}

uint32_t harness_now_ms(void)
{
    return s_now_ms;
}

bool harness_path_closed(bms_path_t path)
{
    return s_closed[path];
}

unsigned harness_open_count(bms_path_t path)
{
    return s_open_count[path];
}

unsigned harness_close_count(bms_path_t path)
{
    return s_close_count[path];
}

uint32_t harness_last_open_ms(bms_path_t path)
{
    return s_last_open_ms[path];
}
