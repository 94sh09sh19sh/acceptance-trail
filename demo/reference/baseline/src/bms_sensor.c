#include "bms_sensor.h"

#include <stddef.h>

/* Demo only, not design guidance: illustrative values for a generic 10-bit NTC divider. */
#define ADC_SHORT_MAX 8u    /* at or below this count the input is shorted to ground */
#define ADC_OPEN_MIN  1015u /* at or above this count the sensor is not connected */

typedef struct {
    uint16_t raw;     /* ADC count */
    int16_t temp_dc;  /* deci-degrees Celsius */
} ntc_point_t;

/* Sorted by falling count (rising temperature). */
static const ntc_point_t k_table[] = {
    { 934, -200 },
    { 788,    0 },
    { 512,  250 },
    { 310,  450 },
    { 204,  600 },
    { 100,  850 },
    {  35, 1250 },
};
#define TABLE_LEN (sizeof k_table / sizeof k_table[0])

bms_sensor_status_t bms_sensor_from_adc(uint16_t raw, int16_t *temp_dc)
{
    if (raw <= ADC_SHORT_MAX) {
        return BMS_SENSOR_SHORT;
    }
    if (raw >= ADC_OPEN_MIN) {
        return BMS_SENSOR_OPEN;
    }
    if (raw >= k_table[0].raw) {
        *temp_dc = k_table[0].temp_dc;
        return BMS_SENSOR_OK;
    }
    for (size_t i = 1; i < TABLE_LEN; i++) {
        if (raw >= k_table[i].raw) {
            const ntc_point_t *cold = &k_table[i - 1];
            const ntc_point_t *hot = &k_table[i];
            const int32_t span_raw = (int32_t)cold->raw - (int32_t)hot->raw;
            const int32_t span_dc = (int32_t)hot->temp_dc - (int32_t)cold->temp_dc;
            const int32_t offset = (int32_t)cold->raw - (int32_t)raw;
            *temp_dc = (int16_t)(cold->temp_dc + (span_dc * offset) / span_raw);
            return BMS_SENSOR_OK;
        }
    }
    *temp_dc = k_table[TABLE_LEN - 1].temp_dc;
    return BMS_SENSOR_OK;
}
